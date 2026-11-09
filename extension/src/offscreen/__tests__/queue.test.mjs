import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueue } from "../queue.mjs";

// Fake engine: records every call and lets the test resolve/reject it by hand.
function fakeFetch() {
  const calls = [];
  const fetchAudio = (text, voice, signal) =>
    new Promise((resolve, reject) => {
      const call = { text, voice, signal, resolve, reject };
      calls.push(call);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  return { calls, fetchAudio };
}

const tick = () => new Promise((r) => setImmediate(r));
const buf = (n) => new Uint8Array([n]).buffer;
// 30 sentences; sentence i has two pieces "i.a" and "i.b".
const sentences = Array.from({ length: 30 }, (_, i) => [`${i}.a`, `${i}.b`]);
const firstPieces = (calls) => calls.filter((c) => c.text.endsWith(".a")).map((c) => Number.parseInt(c.text, 10));

async function resolveAll(calls) {
  // Keep resolving until no pending call is left (later pieces start after earlier ones resolve).
  for (let round = 0; round < 10; round++) {
    await tick();
    const pending = calls.filter((c) => !c.done && !c.signal.aborted);
    if (pending.length === 0) return;
    for (const c of pending) {
      c.done = true;
      c.resolve(buf(c.text.length));
    }
  }
}

test("get prefetches the next three sentences", async () => {
  const { calls, fetchAudio } = fakeFetch();
  const q = createQueue({ fetchAudio });
  q.load(sentences, "alloy");
  const p = q.get(4);
  await tick();
  assert.deepEqual(firstPieces(calls), [4, 5, 6, 7]);
  // Pieces of a sentence are fetched in order: ".b" only after ".a" resolves.
  assert.equal(calls.filter((c) => c.text.endsWith(".b")).length, 0);
  calls.find((c) => c.text === "4.a").resolve(buf(1));
  await tick();
  assert.equal(calls.at(-1).text, "4.b");
  calls.at(-1).resolve(buf(2));
  const audio = await p;
  assert.equal(audio.length, 2);
  assert.deepEqual(audio.map((b) => new Uint8Array(b)[0]), [1, 2]);
  assert.ok(calls.every((c) => c.voice === "alloy"));
  q.clear();
});

test("seek aborts requests outside the new window", async () => {
  const { calls, fetchAudio } = fakeFetch();
  const q = createQueue({ fetchAudio });
  q.load(sentences, "alloy");
  q.get(2);
  await tick();
  const before = new Map(calls.map((c) => [Number.parseInt(c.text, 10), c]));
  q.seek(20);
  await tick();
  for (const i of [3, 4, 5]) assert.equal(before.get(i).signal.aborted, true, `sentence ${i} aborted`);
  const started = firstPieces(calls.slice(before.size));
  assert.deepEqual(started, [20, 21, 22, 23]);
  assert.ok(calls.slice(before.size).every((c) => !c.signal.aborted));
  q.clear();
});

test("setVoice discards cached audio", async () => {
  const { calls, fetchAudio } = fakeFetch();
  const q = createQueue({ fetchAudio });
  q.load(sentences, "alloy");
  const p = q.get(0);
  await resolveAll(calls);
  await p;
  const doneCount = calls.length;
  q.get(4); // window 4..7 — 4..3 overlap nothing; 4..7 in flight
  await tick();
  const inFlight = calls.slice(doneCount);
  q.setVoice("nova");
  await tick();
  assert.ok(inFlight.every((c) => c.signal.aborted), "in-flight requests aborted");
  const refetched = calls.slice(doneCount + inFlight.length);
  assert.deepEqual(firstPieces(refetched), [4, 5, 6, 7]);
  assert.ok(refetched.every((c) => c.voice === "nova"));
  // Previously cached sentence 0 is refetched with the new voice.
  const before = calls.length;
  q.get(0);
  await tick();
  const again = calls.slice(before);
  assert.equal(again[0].text, "0.a");
  assert.equal(again[0].voice, "nova");
  q.clear();
});

test("fetch failure rejects only its index", async () => {
  const { calls, fetchAudio } = fakeFetch();
  const q = createQueue({ fetchAudio });
  q.load(sentences, "alloy");
  const p0 = q.get(0);
  const p1 = q.get(1);
  await tick();
  const boom = new Error("engine down");
  calls.find((c) => c.text === "1.a").reject(boom);
  calls.find((c) => c.text === "1.a").done = true;
  await resolveAll(calls);
  await assert.rejects(p1, boom);
  assert.equal((await p0).length, 2);
  assert.equal((await q.get(2)).length, 2);
  q.clear();
});

test("clear aborts everything", async () => {
  const { calls, fetchAudio } = fakeFetch();
  const q = createQueue({ fetchAudio });
  q.load(sentences, "alloy");
  const p = q.get(0);
  await resolveAll(calls);
  await p;
  q.get(10);
  await tick();
  const n = calls.length;
  q.clear();
  assert.ok(calls.filter((c) => !c.done).every((c) => c.signal.aborted));
  // Cache is empty: a previously fetched sentence is requested again.
  q.get(0);
  await tick();
  assert.equal(calls[n].text, "0.a");
  q.clear();
});
