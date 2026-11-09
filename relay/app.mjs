import { createRelayHandler } from "anytts/server";

const CORS_EXPOSE = "x-anytts-engine, x-anytts-voice, retry-after";
const CORS_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-allow-private-network",
];
const HEALTH_TIMEOUT_MS = 3000;
const VOICES_TIMEOUT_MS = 5000;
// OmniVoice answers with the whole mp3 once generation is done (no streaming), so the first byte
// arrives only after the full unit is synthesized: a long unit on a busy GPU can take tens of
// seconds. anytts' openai default (15 s) would cut those off and retry, doubling the GPU work.
const OMNIVOICE_FIRST_BYTE_MS = 60_000;

const json = (status, body) => Response.json(body, { status });

/** OmniVoice `GET /v1/voices` record → anytts `VoiceInfo`. */
export function toVoiceInfo(record) {
  return {
    id: record.id,
    label: record.label || record.id,
    locale: record.locale || record.language || "",
    gender: record.gender || "female",
    multilingual: record.multilingual === true,
  };
}

/**
 * The browser-origin allowlist from a comma list (`RELAY_ALLOWED_ORIGINS`). Unset or blank means
 * none: there is no default origin.
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function parseAllowedOrigins(value) {
  return (value ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Fetch-style relay in front of OmniVoice: `POST /` (anytts relay protocol, engine `openai` only),
 * `GET /voices` (refreshes the catalog), `GET /health`, with an origin allowlist for browsers.
 * @param {{ omnivoiceUrl: string, allowedOrigins: string[], fetch?: typeof fetch }} options
 * @returns {(req: Request) => Promise<Response>}
 */
export function createRelayApp({ omnivoiceUrl, allowedOrigins, fetch = globalThis.fetch }) {
  const base = omnivoiceUrl.replace(/\/+$/, "");
  const allowed = new Set(allowedOrigins);
  /** The catalog last read from OmniVoice and the relay handler built around it. */
  let current = { key: "", catalog: [], handler: undefined };
  /** Refreshes are numbered in start order; `applied` is the newest one whose answer was kept. */
  let started = 0;
  let applied = 0;

  /**
   * Re-reads `/v1/voices`; rebuilds the handler only when the catalog changed. Throws when
   * unreachable. Refreshes may overlap (the warm-up, a `/voices` call, a POST without a handler):
   * an answer that lands after a newer refresh's answer is dropped, so a stale catalog never
   * replaces a newer one.
   */
  async function refresh() {
    const seq = ++started;
    const res = await fetch(`${base}/v1/voices`, { signal: AbortSignal.timeout(VOICES_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`OmniVoice /v1/voices answered ${res.status}`);
    const { voices = [] } = await res.json();
    if (seq < applied) return current;
    applied = seq;
    // The model-chosen `auto` voice has no locale and varies per call: not a catalog voice.
    const catalog = voices.filter((v) => v && v.id && v.id !== "auto").map(toVoiceInfo);
    const key = JSON.stringify(catalog);
    if (key === current.key) return current;
    const handler =
      catalog.length === 0
        ? undefined
        : createRelayHandler({
            tts: {
              engines: {
                openai: { baseUrl: base, catalog, languageField: "language", firstByteMs: OMNIVOICE_FIRST_BYTE_MS, fetch },
              },
              defaultEngine: "openai",
              // One GPU: OmniVoice serialises generation anyway.
              scheduler: { concurrency: 1, tiers: [{ name: "default" }] },
            },
          });
    current = { key, catalog, handler };
    return current;
  }

  // Warm the catalog at start; a down OmniVoice is retried on the next request.
  refresh().catch(() => {});

  async function synthesize(req) {
    const raw = await req.text();
    let engine;
    try {
      engine = JSON.parse(raw)?.engine;
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    // Only OmniVoice is served here: no standalone Edge proxy, no other engines.
    // `kind` is what the anytts client maps (a pair this relay cannot serve); `error` says why.
    if (engine !== "openai") return json(400, { kind: "unknown-voice", error: "only engine openai is served" });
    let { handler } = current;
    if (!handler) {
      try {
        ({ handler } = await refresh());
      } catch {
        return json(502, { kind: "network" });
      }
      if (!handler) return json(400, { kind: "unknown-voice" });
    }
    return handler(new Request(req.url, { method: "POST", headers: req.headers, body: raw, signal: req.signal }));
  }

  async function listVoices() {
    try {
      return json(200, (await refresh()).catalog);
    } catch {
      // OmniVoice down: serve the last known catalog, if any.
      return current.key ? json(200, current.catalog) : json(502, { kind: "network" });
    }
  }

  async function health() {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      // OmniVoice's body says `ok: true` only once the model is loaded.
      if (res.ok && (await res.json())?.ok === true) return json(200, { ok: true });
    } catch {
      // unreachable, timed out, or not JSON
    }
    return json(503, { ok: false });
  }

  async function route(req, path) {
    if (req.method === "POST" && path === "/") return synthesize(req);
    if (req.method === "GET" && path === "/voices") return listVoices();
    if (req.method === "GET" && path === "/health") return health();
    return json(404, { error: "not found" });
  }

  return async (req) => {
    const origin = req.headers.get("origin");
    const isAllowed = origin !== null && allowed.has(origin);
    const path = new URL(req.url).pathname;

    let res;
    if (origin !== null && !isAllowed && (req.method === "POST" || req.method === "OPTIONS")) {
      // A request without Origin (curl, a server) is not a browser and passes.
      res = json(403, { error: "origin not allowed" });
    } else if (req.method === "OPTIONS") {
      res = new Response(null, { status: 204 });
    } else {
      res = await route(req, path);
    }

    // Copy into a fresh Response so the headers are mutable; only an allowed origin gets CORS.
    const headers = new Headers(res.headers);
    for (const name of CORS_HEADERS) headers.delete(name);
    if (isAllowed) {
      headers.set("access-control-allow-origin", origin);
      headers.set("access-control-expose-headers", CORS_EXPOSE);
      if (req.method === "OPTIONS") {
        headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
        headers.set("access-control-allow-headers", "content-type");
        // Private Network Access: a public page (https://example.com) calling a tailnet host.
        if (req.headers.get("access-control-request-private-network") === "true") {
          headers.set("access-control-allow-private-network", "true");
        }
      }
    }
    headers.append("vary", "Origin");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
