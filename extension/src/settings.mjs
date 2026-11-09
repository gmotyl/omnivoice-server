// User settings kept in chrome.storage.sync.

export const DEFAULTS = Object.freeze({
  baseUrl: "http://localhost:8892/v1",
  apiKey: "",
  voice: "",
  speed: 1.0,
  model: "tts-1",
});

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2.0;

// storage: chrome.storage.sync (or any object with `get(defaults)`); missing storage → DEFAULTS.
export async function loadSettings(storage) {
  if (!storage?.get) return { ...DEFAULTS };
  const got = await storage.get({ ...DEFAULTS });
  return { ...DEFAULTS, ...(got || {}) };
}

export function clampSpeed(value) {
  const n = Number(value);
  if (value === "" || value == null || !Number.isFinite(n)) return DEFAULTS.speed;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.round(n * 10) / 10));
}

// Writes only the known keys named in `patch`; speed is clamped to 0.5–2.0.
// Returns what was written.
export async function saveSettings(storage, patch = {}) {
  const clean = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in patch)) continue;
    clean[key] = key === "speed" ? clampSpeed(patch.speed) : String(patch[key] ?? "").trim();
  }
  await storage.set(clean);
  return clean;
}
