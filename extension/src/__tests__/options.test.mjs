import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { initOptions } from "../options.mjs";
import { DEFAULTS } from "../settings.mjs";

const HTML = readFileSync(new URL("../options.html", import.meta.url), "utf8");

// Fake chrome surface the options page uses: storage.sync and permissions.request.
function fakeChrome({ stored = {}, grant = true } = {}) {
  const data = { ...stored };
  const requests = [];
  const writes = [];
  return {
    data,
    requests,
    writes,
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, ...data }),
        set: async (obj) => {
          writes.push(obj);
          Object.assign(data, obj);
        },
      },
    },
    permissions: {
      request: async (opts) => {
        requests.push(opts);
        return grant;
      },
    },
  };
}

async function setup({ stored, grant, voices } = {}) {
  const { document } = parseHTML(HTML);
  const chrome = fakeChrome({ stored, grant });
  const calls = [];
  const listVoices = async (settings) => {
    calls.push(settings);
    return typeof voices === "function" ? voices(settings) : voices;
  };
  const page = initOptions({ doc: document, chrome, listVoices });
  await page.ready;
  return { document, chrome, calls, page };
}

async function submit(document, page) {
  const form = document.getElementById("options");
  form.dispatchEvent(new document.defaultView.Event("submit", { bubbles: true, cancelable: true }));
  await page.saving;
}

const status = (document) => document.getElementById("status").textContent;

test("options lists engine voices", async () => {
  const { document, calls } = await setup({ voices: { ok: true, voices: ["anna", "ben", "carl"] } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].baseUrl, DEFAULTS.baseUrl);
  const voice = document.getElementById("voice");
  assert.equal(voice.tagName, "SELECT");
  const options = [...voice.querySelectorAll("option")];
  assert.deepEqual(options.map((o) => o.value), ["anna", "ben", "carl"]);
  // Empty stored voice → the first one is selected.
  assert.equal(voice.value, "anna");
  assert.ok(document.querySelector('label[for="voice"]'));
  assert.match(status(document), /Connection OK/);

  // A stored voice in the list is selected.
  const again = await setup({ stored: { voice: "ben" }, voices: { ok: true, voices: ["anna", "ben"] } });
  assert.equal(again.document.getElementById("voice").value, "ben");
});

test("options falls back to free-text voice", async () => {
  const { document } = await setup({ stored: { voice: "my-voice" }, voices: { ok: true, voices: null } });
  const voice = document.getElementById("voice");
  assert.equal(voice.tagName, "INPUT");
  assert.equal(voice.getAttribute("type"), "text");
  assert.equal(voice.value, "my-voice");
  assert.match(status(document), /Connection OK/);
});

test("options shows connection error and still saves", async () => {
  const { document, chrome, page } = await setup({ voices: { ok: false, error: "fetch failed" } });
  assert.match(status(document), /fetch failed/);
  const voice = document.getElementById("voice");
  assert.equal(voice.tagName, "INPUT");
  voice.value = "typed";
  document.getElementById("speed").value = "1.5";
  await submit(document, page);
  assert.equal(chrome.data.voice, "typed");
  assert.equal(chrome.data.speed, 1.5);
  assert.equal(chrome.data.baseUrl, DEFAULTS.baseUrl);
  assert.equal(chrome.requests.length, 0);
  assert.match(document.getElementById("message").textContent, /Saved/);
});

test("non-local base url requests host permission", async () => {
  const { document, chrome, page } = await setup({ voices: { ok: true, voices: ["anna"] } });
  document.getElementById("baseUrl").value = "https://spock.example.ts.net:8444/v1";
  await submit(document, page);
  assert.deepEqual(chrome.requests, [{ origins: ["https://spock.example.ts.net:8444/*"] }]);
  assert.equal(chrome.data.baseUrl, "https://spock.example.ts.net:8444/v1");

  // 127.0.0.1 is covered by the manifest's host permissions: no prompt.
  document.getElementById("baseUrl").value = "http://127.0.0.1:9000/v1";
  await submit(document, page);
  assert.equal(chrome.requests.length, 1);
  assert.equal(chrome.data.baseUrl, "http://127.0.0.1:9000/v1");
});

test("denied permission does not save", async () => {
  const { document, chrome, page } = await setup({ grant: false, voices: { ok: true, voices: ["anna"] } });
  document.getElementById("baseUrl").value = "https://tts.example.com/v1";
  document.getElementById("speed").value = "1.7";
  await submit(document, page);
  assert.deepEqual(chrome.requests, [{ origins: ["https://tts.example.com/*"] }]);
  assert.equal(chrome.writes.length, 0);
  assert.deepEqual(chrome.data, {});
  assert.match(document.getElementById("message").textContent, /permission/i);
  assert.match(document.getElementById("message").textContent, /tts\.example\.com/);
});

const clickTest = (document) =>
  document.getElementById("test").dispatchEvent(new document.defaultView.Event("click", { bubbles: true }));

test("test connection requests host permission for an unsaved non-local url", async () => {
  const { document, chrome, calls, page } = await setup({ voices: { ok: true, voices: ["anna"] } });
  document.getElementById("baseUrl").value = "https://tts.example.com/v1";
  clickTest(document);
  // Asked synchronously, inside the click's user gesture.
  assert.deepEqual(chrome.requests, [{ origins: ["https://tts.example.com/*"] }]);
  await page.saving;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].baseUrl, "https://tts.example.com/v1");
  assert.equal(chrome.writes.length, 0);
});

test("test connection with denied permission says so and does not call the engine", async () => {
  const { document, chrome, calls, page } = await setup({ grant: false, voices: { ok: true, voices: ["anna"] } });
  document.getElementById("baseUrl").value = "https://tts.example.com/v1";
  clickTest(document);
  await page.saving;
  assert.equal(chrome.requests.length, 1);
  assert.equal(calls.length, 1);
  assert.match(status(document), /permission/i);
  assert.match(status(document), /tts\.example\.com/);

  // A local URL needs no permission and is tested directly.
  document.getElementById("baseUrl").value = "http://localhost:9000/v1";
  clickTest(document);
  await page.saving;
  assert.equal(chrome.requests.length, 1);
  assert.equal(calls.length, 2);
});

test("an empty voice list reports that the server lists no voices", async () => {
  const { document } = await setup({ stored: { voice: "typed" }, voices: { ok: true, voices: [] } });
  assert.match(status(document), /lists no voices/);
  const voice = document.getElementById("voice");
  assert.equal(voice.tagName, "INPUT");
  assert.equal(voice.value, "typed");
});

test("options saves the autoscroll checkbox", async () => {
  const { document, chrome, page } = await setup({ stored: { autoscroll: false }, voices: { ok: true, voices: null } });
  const box = document.getElementById("autoscroll");
  assert.equal(box.getAttribute("type"), "checkbox");
  assert.ok(document.querySelector('label[for="autoscroll"]'));
  assert.equal(box.checked, false);
  box.checked = true;
  await submit(document, page);
  assert.equal(chrome.data.autoscroll, true);
});
