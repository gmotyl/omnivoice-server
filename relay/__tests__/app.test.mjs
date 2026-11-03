import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRelayApp } from "../app.mjs";

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
          return res.end(JSON.stringify({ status: "loading" }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ status: "ok" }));
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
