import { test } from "node:test";
import assert from "node:assert/strict";
import { createOffscreen } from "../offscreen.mjs";

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

class FakeAudio extends EventTarget {
  src = "";
  paused = true;
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {
    this.src = "";
  }
  load() {}
}

function setup() {
  const listeners = [];
  const sent = [];
  const runtime = {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    sendMessage: async (msg) => sent.push(msg),
  };
  const spoken = [];
  const speak = async (settings, { text, voice }) => {
    spoken.push({ settings, text, voice });
    return new ArrayBuffer(1);
  };
  createOffscreen({ runtime, audio: new FakeAudio(), speak });
  const deliver = (msg, sender = {}) => listeners.forEach((fn) => fn(msg, sender));
  return { deliver, sent, spoken };
}

const settings = { baseUrl: "http://localhost:9000/v1", apiKey: "k", model: "m1" };

test("offscreen speaks with the settings forwarded on play", async () => {
  const { deliver, sent, spoken } = setup();
  deliver({ type: "play", target: "offscreen", sentences: [["Hi."]], start: 0, voice: "v1", speed: 1, settings });
  await settle();
  assert.deepEqual(spoken[0], { settings, text: "Hi.", voice: "v1" });
  assert.ok(sent.some((m) => m.type === "sentence-start" && m.index === 0));
});

test("offscreen ignores messages not relayed by the service worker", async () => {
  const { deliver, spoken } = setup();
  const play = { type: "play", sentences: [["Hi."]], start: 0, voice: "v1", speed: 1, settings };
  deliver(play); // no target stamp
  deliver({ ...play, target: "offscreen" }, { tab: { id: 1 } }); // from a content script
  await settle();
  assert.equal(spoken.length, 0);
});
