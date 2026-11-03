import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRelayApp, toVoiceInfo } from "../app.mjs";

const ORIGIN = "https://motyl.dev";
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]); // "ID3" header bytes

const record = (id, extra = {}) => ({
  id,
  source: "bundled",
  language: "pl",
  locale: "pl-PL",
  gender: "female",
  label: id,
  multilingual: false,
  ref_text: "x",
  description: null,
  ...extra,
});
const AUTO = { id: "auto", source: null, language: null, locale: null, gender: null, label: null, multilingual: null, ref_text: null, description: "model-chosen, varies per call" };

/** A stub OmniVoice on an ephemeral port; its state is mutable from the test. */
async function stubOmniVoice() {
  const state = { voices: [AUTO, record("pl-female")], healthy: true, speech: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/v1/voices") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ voices: state.voices }));
      }
      if (req.method === "GET" && req.url === "/health") {
        if (!state.healthy) {
          res.writeHead(503, { "content-type": "application/json" });
          return res.end(JSON.stringify({ ok: false }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(state.healthBody ?? { ok: true, device: "cuda:0" }));
      }
      if (req.method === "POST" && req.url === "/v1/audio/speech") {
        state.speech.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "content-type": "audio/mpeg" });
        return res.end(MP3);
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { state, url, close };
}

/** A URL nothing listens on. */
async function deadUrl() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

const relay = (omnivoiceUrl) => createRelayApp({ omnivoiceUrl, allowedOrigins: [ORIGIN, "http://localhost:3000"] });

const post = (body, origin = ORIGIN) =>
  new Request("http://relay.test/", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });

const get = (path, origin = ORIGIN) => new Request(`http://relay.test${path}`, { headers: origin ? { origin } : {} });

test("relays an openai synthesis to OmniVoice and returns mp3 with engine and voice headers", async (t) => {
  const ov = await stubOmniVoice();
  t.after(ov.close);
  const app = relay(ov.url);

  const res = await app(post({ engine: "openai", text: "Hello there", voice: "pl-female", lang: "en" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/mpeg");
  assert.equal(res.headers.get("x-anytts-engine"), "openai");
  assert.equal(res.headers.get("x-anytts-voice"), "pl-female");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), MP3);

  assert.equal(ov.state.speech.length, 1);
  const [sent] = ov.state.speech;
  assert.equal(sent.input, "Hello there");
  assert.equal(sent.voice, "pl-female");
  assert.equal(sent.response_format, "mp3");
  // languageField rule: a lang whose base differs from the voice's locale is sent as `language`.
  assert.equal(sent.language, "en");

  // ...and a lang matching the voice's locale is left to the voice's own language.
  const same = await app(post({ engine: "openai", text: "Dzień dobry", voice: "pl-female", lang: "pl-PL" }));
  assert.equal(same.status, 200);
  assert.equal("language" in ov.state.speech[1], false);
});

test("answers 502 network when OmniVoice is down", async (t) => {
  // Down from the start: the relay still starts and answers.
  const never = relay(await deadUrl());
  const res = await never(post({ engine: "openai", text: "Hi", voice: "pl-female" }));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { kind: "network" });

  // Down after the catalog was loaded: the engine's own network failure.
  const ov = await stubOmniVoice();
  const app = relay(ov.url);
  assert.equal((await app(get("/voices"))).status, 200);
  await ov.close();
  const later = await app(post({ engine: "openai", text: "Hi", voice: "pl-female" }));
  assert.equal(later.status, 502);
  assert.deepEqual(await later.json(), { kind: "network" });
});

test("lists OmniVoice voices as VoiceInfo without auto", async (t) => {
  const ov = await stubOmniVoice();
  t.after(ov.close);
  ov.state.voices.push(record("en-male", { language: "en", locale: "en-US", gender: "male", label: "En Male", multilingual: true }));
  const app = relay(ov.url);

  const res = await app(get("/voices"));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await res.json(), [
    { id: "pl-female", label: "pl-female", locale: "pl-PL", gender: "female", multilingual: false },
    { id: "en-male", label: "En Male", locale: "en-US", gender: "male", multilingual: true },
  ]);
});

test("a voice cloned after start can be synthesized after /voices refresh", async (t) => {
  const ov = await stubOmniVoice();
  t.after(ov.close);
  const app = relay(ov.url);
  assert.equal((await app(post({ engine: "openai", text: "Hi", voice: "pl-female" }))).status, 200);

  ov.state.voices.push(record("me", { source: "custom", label: null }));
  const before = await app(post({ engine: "openai", text: "Hi", voice: "me" }));
  assert.equal(before.status, 400);
  assert.deepEqual(await before.json(), { kind: "unknown-voice" });

  const voices = await (await app(get("/voices"))).json();
  assert.deepEqual(voices.map((v) => v.id), ["pl-female", "me"]);
  // A record without a label falls back to its id.
  assert.equal(voices[1].label, "me");

  const after = await app(post({ engine: "openai", text: "Hi", voice: "me" }));
  assert.equal(after.status, 200);
  assert.equal(after.headers.get("x-anytts-voice"), "me");
  assert.equal(ov.state.speech.at(-1).voice, "me");
});

test("health is 200 when OmniVoice is healthy and 503 when it is not", async (t) => {
  const ov = await stubOmniVoice();
  t.after(ov.close);
  const app = relay(ov.url);

  const ok = await app(get("/health"));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });

  ov.state.healthy = false;
  assert.equal((await app(get("/health"))).status, 503);

  const down = relay(await deadUrl());
  assert.equal((await down(get("/health"))).status, 503);
});

test("allowed origin gets CORS headers and a 204 preflight", async (t) => {
  const ov = await stubOmniVoice();
  t.after(ov.close);
  const app = relay(ov.url);

  const preflight = await app(
    new Request("http://relay.test/", {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    }),
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
  assert.equal(preflight.headers.get("access-control-allow-headers"), "content-type");
  assert.match(preflight.headers.get("vary") ?? "", /Origin/);

  for (const res of [await app(post({ engine: "openai", text: "Hi", voice: "pl-female" })), await app(get("/voices")), await app(get("/health"))]) {
    assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
    assert.match(res.headers.get("vary") ?? "", /Origin/);
    assert.equal(res.headers.get("access-control-expose-headers"), "x-anytts-engine, x-anytts-voice, retry-after");
  }

  // The second listed origin is allowed too.
  const local = await app(get("/health", "http://localhost:3000"));
  assert.equal(local.headers.get("access-control-allow-origin"), "http://localhost:3000");
});

test("other origin gets no CORS headers and 403 on POST", async (t) => {
  const ov = await stubOmniVoice();
  t.after(ov.close);
  const app = relay(ov.url);
  const EVIL = "https://evil.example";

  const res = await app(post({ engine: "openai", text: "Hi", voice: "pl-female" }, EVIL));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(ov.state.speech.length, 0);

  const voices = await app(get("/voices", EVIL));
  assert.equal(voices.headers.get("access-control-allow-origin"), null);
  assert.equal(voices.headers.get("access-control-expose-headers"), null);

  const preflight = await app(new Request("http://relay.test/", { method: "OPTIONS", headers: { origin: EVIL } }));
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  assert.equal(preflight.headers.get("access-control-allow-methods"), null);
});

const CORS_NAMES = [
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-allow-private-network",
];

/** A deferred promise the test settles by hand. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const voicesResponse = (voices) => Response.json({ voices });
const mp3Response = () => new Response(MP3, { status: 200, headers: { "content-type": "audio/mpeg" } });

/**
 * A fake `fetch` for OmniVoice: every call is recorded; `/v1/voices` and `/v1/audio/speech` are
 * answered by `routes` (a function per path, returning a Response or a promise of one).
 */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method ?? "GET" });
    const route = routes[path];
    if (!route) throw new TypeError(`fetch failed: no route for ${path}`);
    return route(init);
  };
  return { fetch, calls };
}

test("a POST with no engine or engine edge is a 400 that reaches neither Edge nor OmniVoice", async () => {
  const { fetch, calls } = fakeFetch({
    "/v1/voices": () => voicesResponse([record("pl-female")]),
    "/v1/audio/speech": () => mp3Response(),
  });
  const app = createRelayApp({ omnivoiceUrl: "http://omnivoice.test", allowedOrigins: [ORIGIN], fetch });

  // A valid Edge voice: without the guard, anytts' relay would hand this to its Edge engine.
  for (const body of [
    { text: "Hi", voice: "en-US-AvaMultilingualNeural" },
    { engine: "edge", text: "Hi", voice: "en-US-AvaMultilingualNeural" },
  ]) {
    const res = await app(post(body));
    assert.equal(res.status, 400);
    const answer = await res.json();
    // `kind` stays what the anytts client maps; `error` says why.
    assert.equal(answer.kind, "unknown-voice");
    assert.equal(answer.error, "only engine openai is served");
  }
  assert.equal(calls.filter((c) => c.path !== "/v1/voices").length, 0);
});

test("a request without Origin is served, with no CORS headers", async (t) => {
  const ov = await stubOmniVoice();
  t.after(ov.close);
  const app = relay(ov.url);

  const res = await app(post({ engine: "openai", text: "Hi", voice: "pl-female" }, null));
  assert.equal(res.status, 200);
  assert.equal(ov.state.speech.length, 1);
  // anytts adds an expose header to its audio response; without an allowed origin it is stripped.
  for (const name of CORS_NAMES) assert.equal(res.headers.get(name), null, name);
  assert.equal((await app(get("/health", null))).status, 200);
});

test("a disallowed origin gets none of the CORS headers on any route", async (t) => {
  const ov = await stubOmniVoice();
  t.after(ov.close);
  const app = relay(ov.url);
  const EVIL = "https://evil.example";

  const responses = [
    await app(post({ engine: "openai", text: "Hi", voice: "pl-female" }, EVIL)),
    await app(get("/voices", EVIL)),
    await app(get("/health", EVIL)),
    await app(
      new Request("http://relay.test/", {
        method: "OPTIONS",
        headers: { origin: EVIL, "access-control-request-method": "POST", "access-control-request-private-network": "true" },
      }),
    ),
  ];
  for (const res of responses) {
    for (const name of CORS_NAMES) assert.equal(res.headers.get(name), null, `${res.status} ${name}`);
  }
  assert.equal(ov.state.speech.length, 0);
});

test("/voices serves the last known catalog while OmniVoice is down, 502 when none ever loaded", async () => {
  let up = true;
  const { fetch } = fakeFetch({
    "/v1/voices": () => {
      if (!up) throw new TypeError("fetch failed");
      return voicesResponse([AUTO, record("pl-female")]);
    },
  });
  const app = createRelayApp({ omnivoiceUrl: "http://omnivoice.test", allowedOrigins: [ORIGIN], fetch });
  const loaded = await (await app(get("/voices"))).json();
  assert.deepEqual(loaded.map((v) => v.id), ["pl-female"]);

  up = false;
  const stale = await app(get("/voices"));
  assert.equal(stale.status, 200);
  assert.deepEqual(await stale.json(), loaded);

  const never = relay(await deadUrl());
  const none = await never(get("/voices"));
  assert.equal(none.status, 502);
  assert.deepEqual(await none.json(), { kind: "network" });
});

test("toVoiceInfo falls back for locale, gender and label", () => {
  assert.deepEqual(toVoiceInfo({ id: "a", language: "en", locale: null, gender: null, label: null, multilingual: null }), {
    id: "a",
    label: "a",
    locale: "en",
    gender: "female",
    multilingual: false,
  });
  assert.deepEqual(toVoiceInfo({ id: "b" }), { id: "b", label: "b", locale: "", gender: "female", multilingual: false });
  assert.equal(toVoiceInfo({ id: "c", gender: "male" }).gender, "male");
});

test("the relay works once OmniVoice comes up after the relay started", async () => {
  let up = false;
  const down = () => {
    throw new TypeError("fetch failed");
  };
  const { fetch } = fakeFetch({
    "/v1/voices": () => (up ? voicesResponse([AUTO, record("pl-female")]) : down()),
    "/health": () => (up ? Response.json({ ok: true }) : down()),
    "/v1/audio/speech": () => (up ? mp3Response() : down()),
  });
  const app = createRelayApp({ omnivoiceUrl: "http://omnivoice.test", allowedOrigins: [ORIGIN], fetch });

  assert.equal((await app(post({ engine: "openai", text: "Hi", voice: "pl-female" }))).status, 502);
  assert.equal((await app(get("/health"))).status, 503);
  assert.equal((await app(get("/voices"))).status, 502);

  up = true;
  const res = await app(post({ engine: "openai", text: "Hi", voice: "pl-female" }));
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), MP3);
  assert.equal((await app(get("/health"))).status, 200);
  assert.deepEqual((await (await app(get("/voices"))).json()).map((v) => v.id), ["pl-female"]);
});

test("an older /v1/voices answer never overwrites a newer catalog", async () => {
  const answers = [];
  const { fetch } = fakeFetch({
    "/v1/voices": () => {
      const d = deferred();
      answers.push(d);
      return d.promise;
    },
    "/v1/audio/speech": () => mp3Response(),
  });
  const app = createRelayApp({ omnivoiceUrl: "http://omnivoice.test", allowedOrigins: [ORIGIN], fetch });
  // answers[0] is the warm-up refresh, still in flight; a /voices call starts a second one.
  const listing = app(get("/voices"));
  assert.equal(answers.length, 2);

  // The newer refresh (a voice cloned meanwhile) lands first...
  answers[1].resolve(voicesResponse([record("pl-female"), record("me")]));
  assert.deepEqual((await (await listing).json()).map((v) => v.id), ["pl-female", "me"]);
  // ...then the older one, with the catalog from before the clone.
  answers[0].resolve(voicesResponse([record("pl-female")]));
  await new Promise((resolve) => setImmediate(resolve));

  const res = await app(post({ engine: "openai", text: "Hi", voice: "me" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-anytts-voice"), "me");

  // And the last known catalog is the newer one.
  const down = app(get("/voices"));
  answers[2].reject(new TypeError("fetch failed"));
  assert.deepEqual((await (await down).json()).map((v) => v.id), ["pl-female", "me"]);
});

test("health needs OmniVoice's body to say ok: true", async (t) => {
  const ov = await stubOmniVoice();
  t.after(ov.close);
  const app = relay(ov.url);

  ov.state.healthBody = { ok: false, device: "cuda:0" };
  assert.equal((await app(get("/health"))).status, 503);
  ov.state.healthBody = { status: "ok" };
  assert.equal((await app(get("/health"))).status, 503);
  ov.state.healthBody = { ok: true };
  assert.equal((await app(get("/health"))).status, 200);

  const { fetch } = fakeFetch({ "/health": () => new Response("not json", { status: 200 }) });
  const garbled = createRelayApp({ omnivoiceUrl: "http://omnivoice.test", allowedOrigins: [ORIGIN], fetch });
  assert.equal((await garbled(get("/health"))).status, 503);
});

test("a slow OmniVoice answer within 60 s is not cut off by the first-byte deadline", async (t) => {
  const speech = deferred();
  const speechCalled = deferred();
  const { fetch, calls } = fakeFetch({
    "/v1/voices": () => voicesResponse([record("pl-female")]),
    // Only the first call is the real one: a timed-out first call would be retried by anytts.
    "/v1/audio/speech": () => {
      if (calls.filter((c) => c.path === "/v1/audio/speech").length > 1) throw new TypeError("retried");
      speechCalled.resolve();
      return speech.promise;
    },
  });
  const app = createRelayApp({ omnivoiceUrl: "http://omnivoice.test", allowedOrigins: [ORIGIN], fetch });
  assert.equal((await app(get("/voices"))).status, 200);

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = app(post({ engine: "openai", text: "A long paragraph", voice: "pl-female" }));
  await speechCalled.promise;
  // OmniVoice returns the whole mp3 at once: a long unit on a busy GPU takes a while.
  t.mock.timers.tick(45_000);
  speech.resolve(mp3Response());
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), MP3);
  assert.equal(calls.filter((c) => c.path === "/v1/audio/speech").length, 1);
});

test("an allowed origin's private-network preflight is allowed", async (t) => {
  const ov = await stubOmniVoice();
  t.after(ov.close);
  const app = relay(ov.url);
  const preflight = (headers) => app(new Request("http://relay.test/", { method: "OPTIONS", headers }));

  const pna = await preflight({ origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-private-network": "true" });
  assert.equal(pna.status, 204);
  assert.equal(pna.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(pna.headers.get("access-control-allow-private-network"), "true");

  // Only asked for: a plain preflight does not get it.
  const plain = await preflight({ origin: ORIGIN, "access-control-request-method": "POST" });
  assert.equal(plain.headers.get("access-control-allow-private-network"), null);
});
