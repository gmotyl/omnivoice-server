// User settings kept in chrome.storage.sync. Minimal loader; the options task extends it.

export const DEFAULTS = Object.freeze({
  baseUrl: "http://localhost:8892/v1",
  apiKey: "",
  voice: "",
  speed: 1.0,
  model: "tts-1",
});

// storage: chrome.storage.sync (or any object with `get(defaults)`); missing storage → DEFAULTS.
export async function loadSettings(storage) {
  if (!storage?.get) return { ...DEFAULTS };
  const got = await storage.get({ ...DEFAULTS });
  return { ...DEFAULTS, ...(got || {}) };
}
