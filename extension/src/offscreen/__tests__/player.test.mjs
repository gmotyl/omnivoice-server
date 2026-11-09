import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueue } from "../queue.mjs";
import { createPlayer } from "../player.mjs";
import { EngineError } from "../../engine.mjs";

const tick = () => new Promise((r) => setImmediate(r));
async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

// Fake engine: resolves each piece on the next tick with the bytes of "voice:text",
// unless `fail` returns an error for it. Records every call.
function fakeEngine(fail = () => null) {
  const calls = [];
  const fetchAudio = (text, voice, signal) => {
    calls.push({ text, voice, signal });
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      setImmediate(() => {
        const err = fail(text, voice);
        if (err) reject(err);
        else resolve(new TextEncoder().encode(`${voice}:${text}`).buffer);
      });
    });
  };
  return { calls, fetchAudio };
}

// Fake Blob + object URLs: each URL maps back to the "voice:text" it was made from.
class FakeBlob {
  constructor(parts, opts) {
    this.parts = parts;
    this.type = opts?.type;
  }
}
function fakeUrls() {
  const created = new Map();
  const revoked = [];
  let n = 0;
  return {
    created,
    revoked,
    live: () => [...created.keys()].filter((u) => !revoked.includes(u)),
    textOf: (u) => new TextDecoder().decode(created.get(u).parts[0]),
    createObjectURL(blob) {
      const u = `blob:fake/${++n}`;
      created.set(u, blob);
      return u;
    },
    revokeObjectURL(u) {
      revoked.push(u);
    },
  };
}

class FakeAudio extends EventTarget {
  src = "";
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = false;
  paused = true;
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(name) {
    if (name === "src") this.src = "";
  }
  load() {}
  end() {
    this.paused = true;
    this.dispatchEvent(new Event("ended"));
  }
}

// 4 sentences; sentence i has pieces "i.a" and "i.b".
const sentences = Array.from({ length: 4 }, (_, i) => [`${i}.a`, `${i}.b`]);

function setup(fail) {
  const engine = fakeEngine(fail);
  const queue = createQueue({ fetchAudio: engine.fetchAudio });
  const audio = new FakeAudio();
  const urls = fakeUrls();
  const events = [];
  const player = createPlayer({
    queue,
    audio,
    emit: (msg) => events.push(msg),
    settings: { voice: "alloy", speed: 1 },
    url: urls,
    Blob: FakeBlob,
  });
  const playing = () => urls.textOf(audio.src);
  return { engine, queue, audio, urls, events, player, playing };
}

test("play emits loading then sentence-start and playing", async () => {
  const { audio, events, player, playing } = setup();
  player.play({ sentences, start: 1, voice: "alloy", speed: 1 });
  assert.deepEqual(events, [{ type: "state", state: "loading" }]);
  await settle();
  assert.deepEqual(events, [
    { type: "state", state: "loading" },
    { type: "sentence-start", index: 1 },
    { type: "state", state: "playing" },
  ]);
  assert.equal(audio.paused, false);
  assert.equal(playing(), "alloy:1.a");
  player.stop();
});

test("advances through sentences and ends idle", async () => {
  const { audio, events, player, playing } = setup();
  player.play({ sentences, start: 2, voice: "alloy", speed: 1 });
  await settle();
  assert.equal(playing(), "alloy:2.a");
  audio.end();
  await settle();
  assert.equal(playing(), "alloy:2.b");
  audio.end();
  await settle();
  assert.equal(playing(), "alloy:3.a");
  audio.end();
  await settle();
  assert.equal(playing(), "alloy:3.b");
  audio.end();
  await settle();
  const starts = events.filter((e) => e.type === "sentence-start").map((e) => e.index);
  assert.deepEqual(starts, [2, 3]);
  assert.deepEqual(events.at(-1), { type: "state", state: "idle" });
  assert.equal(events.filter((e) => e.type === "state" && e.state === "error").length, 0);
});

test("setSpeed changes playbackRate without fetching", async () => {
  const { audio, engine, player } = setup();
  player.play({ sentences, start: 0, voice: "alloy", speed: 1 });
  await settle();
  const before = engine.calls.length;
  player.setSpeed(1.3);
  await settle();
  assert.equal(audio.playbackRate, 1.3);
  assert.equal(audio.preservesPitch, true);
  assert.equal(engine.calls.length, before, "no new fetch");
  // The rate also sticks for the next piece.
  audio.end();
  await settle();
  assert.equal(audio.playbackRate, 1.3);
  player.stop();
});

test("setVoice restarts the current sentence", async () => {
  const { audio, engine, events, player, playing } = setup();
  player.play({ sentences, start: 0, voice: "alloy", speed: 1 });
  await settle();
  audio.end(); // 0.b
  await settle();
  audio.end(); // 1.a
  await settle();
  assert.equal(playing(), "alloy:1.a");
  const n = events.length;
  player.setVoice("nova");
  await settle();
  assert.equal(playing(), "nova:1.a", "current sentence restarts from its first piece");
  assert.equal(audio.paused, false);
  assert.ok(engine.calls.some((c) => c.text === "1.a" && c.voice === "nova"));
  const after = events.slice(n);
  assert.deepEqual(
    after.filter((e) => e.type === "sentence-start"),
    [{ type: "sentence-start", index: 1 }],
  );
  // The aborted alloy fetches never surface as an error.
  assert.equal(after.filter((e) => e.state === "error").length, 0);
  assert.deepEqual(after.at(-1), { type: "state", state: "playing" });
  player.stop();
});

test("engine error stops with error state", async () => {
  const { audio, events, player, urls } = setup((text) =>
    text === "1.a" ? new EngineError(500, "voice not found") : null,
  );
  player.play({ sentences, start: 0, voice: "alloy", speed: 1 });
  await settle();
  audio.end();
  await settle();
  audio.end(); // sentence 1 fails
  await settle();
  assert.deepEqual(events.at(-1), { type: "state", state: "error", error: "voice not found" });
  assert.equal(audio.paused, true);
  assert.deepEqual(urls.live(), [], "no object url left behind");
  // Retrying is a seek: it refetches (here it fails again, still as a single error).
  const errorsBefore = events.filter((e) => e.state === "error").length;
  player.seek(1);
  await settle();
  assert.equal(events.filter((e) => e.state === "error").length, errorsBefore + 1);
  player.stop();
});

test("stop clears queue and revokes object urls", async () => {
  const { audio, engine, events, player, urls } = setup();
  player.play({ sentences, start: 0, voice: "alloy", speed: 1 });
  await settle();
  audio.end(); // piece 0.a ended → its url is revoked
  await settle();
  assert.equal(urls.created.size, 2);
  assert.equal(urls.live().length, 1, "ended piece revoked");
  const inFlight = engine.calls.filter((c) => !c.signal.aborted);
  player.stop();
  assert.equal(audio.paused, true);
  assert.deepEqual(urls.live(), [], "current piece revoked on stop");
  assert.ok(inFlight.every((c) => c.signal.aborted), "queue cleared");
  assert.deepEqual(events.at(-1), { type: "state", state: "idle" });
  // Nothing plays afterwards.
  await settle();
  assert.equal(urls.created.size, 2);
});
