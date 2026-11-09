import { test } from "node:test";
import assert from "node:assert/strict";
import { listVoices, speak, EngineError } from "../engine.mjs";

const settings = { baseUrl: "http://localhost:8000/v1", apiKey: "", model: "omnivoice" };

// Fake fetch: records calls and answers through a per-URL handler.
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  impl.calls = calls;
  return impl;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const audio = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });

test("speak posts model, input and voice to /audio/speech", async () => {
  const f = fakeFetch(() => audio());
  const buf = await speak(settings, { text: "Hello.", voice: "alice" }, undefined, f);
  assert.ok(buf instanceof ArrayBuffer);
  assert.equal(buf.byteLength, 3);
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, "http://localhost:8000/v1/audio/speech");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), { model: "omnivoice", input: "Hello.", voice: "alice" });
});

test("speak sends bearer only when a key is set", async () => {
  const f = fakeFetch(() => audio());
  await speak({ ...settings, apiKey: "sk-123" }, { text: "a", voice: "v" }, undefined, f);
  await speak({ ...settings, apiKey: "" }, { text: "a", voice: "v" }, undefined, f);
  assert.equal(f.calls[0].init.headers.Authorization, "Bearer sk-123");
  assert.equal("Authorization" in f.calls[1].init.headers, false);
});

test("speak maps http errors to EngineError", async () => {
  const f1 = fakeFetch(() => json({ error: { message: "unknown voice" } }, 400));
  await assert.rejects(speak(settings, { text: "a", voice: "x" }, undefined, f1), (err) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.status, 400);
    assert.equal(err.message, "unknown voice");
    return true;
  });
  const f2 = fakeFetch(() => new Response("bad gateway", { status: 502 }));
  await assert.rejects(speak(settings, { text: "a", voice: "x" }, undefined, f2), (err) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.status, 502);
    assert.equal(err.message, "bad gateway");
    return true;
  });
});

test("speak abort rejects with AbortError", async () => {
  // Fake fetch that honours the signal like the real one.
  const f = fakeFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      }),
  );
  const ctrl = new AbortController();
  const p = speak(settings, { text: "a", voice: "v" }, ctrl.signal, f);
  ctrl.abort();
  await assert.rejects(p, (err) => {
    assert.equal(err.name, "AbortError");
    assert.equal(err instanceof EngineError, false);
    return true;
  });
});

test("listVoices returns ids from /audio/voices", async () => {
  const f = fakeFetch((url) =>
    url.endsWith("/audio/voices") ? json({ voices: ["alice", "bob"] }) : json({}, 404),
  );
  const res = await listVoices(settings, f);
  assert.deepEqual(res, { ok: true, voices: ["alice", "bob"] });
  assert.equal(f.calls[0].url, "http://localhost:8000/v1/audio/voices");
});

test("listVoices falls back to /models with free-text voice", async () => {
  const f = fakeFetch((url) =>
    url.endsWith("/models") ? json({ data: [{ id: "tts-1" }] }) : json({ error: { message: "nope" } }, 404),
  );
  const res = await listVoices(settings, f);
  assert.deepEqual(res, { ok: true, voices: null });
  assert.equal(f.calls[1].url, "http://localhost:8000/v1/models");
});

test("listVoices reports failure when both endpoints fail", async () => {
  const f = fakeFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  const res = await listVoices(settings, f);
  assert.equal(res.ok, false);
  assert.ok(res.error);
  assert.equal("voices" in res, false);
});

test("trailing slash in baseUrl is normalised", async () => {
  const s = { ...settings, baseUrl: "http://localhost:8000/v1/" };
  const f = fakeFetch((url) => (url.endsWith("/audio/voices") ? json({ voices: [] }) : audio()));
  await speak(s, { text: "a", voice: "v" }, undefined, f);
  await listVoices(s, f);
  assert.equal(f.calls[0].url, "http://localhost:8000/v1/audio/speech");
  assert.equal(f.calls[1].url, "http://localhost:8000/v1/audio/voices");
  for (const c of f.calls) assert.equal(c.url.replace("://", "").includes("//"), false);
});
