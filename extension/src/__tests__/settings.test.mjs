import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, loadSettings, saveSettings } from "../settings.mjs";

// Fake chrome.storage.sync: get(defaults) fills missing keys, set(obj) merges.
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (defaults) => ({ ...defaults, ...data }),
    set: async (obj) => {
      Object.assign(data, obj);
    },
  };
}

test("loadSettings returns defaults", async () => {
  assert.deepEqual(DEFAULTS, {
    baseUrl: "http://localhost:8892/v1",
    apiKey: "",
    voice: "",
    speed: 1.0,
    model: "tts-1",
  });
  assert.deepEqual(await loadSettings(fakeStorage()), DEFAULTS);
  assert.deepEqual(await loadSettings(undefined), DEFAULTS);
});

test("speed is clamped", async () => {
  const storage = fakeStorage();
  assert.equal((await saveSettings(storage, { speed: 3 })).speed, 2);
  assert.equal(storage.data.speed, 2);
  await saveSettings(storage, { speed: 0.1 });
  assert.equal(storage.data.speed, 0.5);
  await saveSettings(storage, { speed: "1.3" });
  assert.equal(storage.data.speed, 1.3);
  await saveSettings(storage, { speed: "fast" });
  assert.equal(storage.data.speed, DEFAULTS.speed);
  // A patch only writes the keys it names, and unknown keys are dropped.
  await saveSettings(storage, { voice: "anna", junk: 1 });
  assert.deepEqual(storage.data, { speed: DEFAULTS.speed, voice: "anna" });
});
