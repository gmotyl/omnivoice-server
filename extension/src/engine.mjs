// OpenAI-compatible engine client: /audio/speech for synthesis, /audio/voices or /models for discovery.
// settings: {baseUrl, apiKey, model}. fetchImpl is injectable so tests can fake the network.

export class EngineError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "EngineError";
    this.status = status;
  }
}

function url(settings, path) {
  return String(settings.baseUrl ?? "").replace(/\/+$/, "") + path;
}

function headers(settings, extra = {}) {
  const h = { ...extra };
  if (settings.apiKey) h.Authorization = `Bearer ${settings.apiKey}`;
  return h;
}

// Prefer the OpenAI-style `error.message` from a JSON body, else the raw text.
// An AbortError while reading the body is rethrown so an abort never turns into an EngineError.
async function errorMessage(res) {
  const text = await res.text().catch((err) => {
    if (err?.name === "AbortError") throw err;
    return "";
  });
  try {
    const body = JSON.parse(text);
    const msg = body?.error?.message ?? (typeof body?.error === "string" ? body.error : undefined);
    if (msg) return String(msg);
  } catch {
    // not JSON — fall through to the text
  }
  return text || `HTTP ${res.status}`;
}

export async function speak(settings, { text, voice }, signal, fetchImpl = fetch) {
  // Network and abort errors propagate as-is, so an abort stays an AbortError.
  const res = await fetchImpl(url(settings, "/audio/speech"), {
    method: "POST",
    headers: headers(settings, { "content-type": "application/json" }),
    body: JSON.stringify({ model: settings.model, input: text, voice }),
    signal,
  });
  if (!res.ok) {
    const message = await errorMessage(res);
    signal?.throwIfAborted();
    throw new EngineError(res.status, message);
  }
  return res.arrayBuffer();
}

async function getJson(settings, path, fetchImpl) {
  const res = await fetchImpl(url(settings, path), { method: "GET", headers: headers(settings) });
  if (!res.ok) throw new EngineError(res.status, await errorMessage(res));
  return res.json();
}

export async function listVoices(settings, fetchImpl = fetch) {
  try {
    const body = await getJson(settings, "/audio/voices", fetchImpl);
    if (Array.isArray(body?.voices)) return { ok: true, voices: body.voices.map(String) };
  } catch {
    // no voice listing — try /models below
  }
  try {
    await getJson(settings, "/models", fetchImpl);
    // Engine reachable but cannot list voices: the voice is entered as free text.
    return { ok: true, voices: null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
