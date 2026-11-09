// Options page: edits the settings in chrome.storage.sync, lists the engine's voices and
// tests the connection. An extension page has the manifest's host permissions, so it
// calls the engine directly instead of going through the service worker.
import { listVoices as engineListVoices } from "./engine.mjs";
import { loadSettings, saveSettings, clampSpeed } from "./settings.mjs";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

// Origin that needs a runtime host permission, or null when the manifest already covers it.
// Throws on an invalid URL.
function permissionOrigin(baseUrl) {
  const u = new URL(baseUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Base URL must start with http:// or https://");
  if (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname)) return null;
  return u.origin;
}

export function initOptions({
  doc = globalThis.document,
  chrome = globalThis.chrome,
  listVoices = engineListVoices,
} = {}) {
  const $ = (id) => doc.getElementById(id);
  const form = $("options");
  const status = $("status");
  const message = $("message");
  const page = { ready: null, saving: Promise.resolve() };

  function setText(el, text, kind = "") {
    el.textContent = text;
    el.className = kind;
  }

  // Replace the voice control: a select of ids when the engine lists them, else free text.
  function renderVoice(voices, current) {
    const holder = $("voice-field");
    holder.textContent = "";
    let el;
    if (Array.isArray(voices) && voices.length) {
      el = doc.createElement("select");
      const selected = voices.includes(current) ? current : voices[0];
      for (const id of voices) {
        const opt = doc.createElement("option");
        opt.value = id;
        opt.textContent = id;
        if (id === selected) opt.setAttribute("selected", "");
        el.appendChild(opt);
      }
    } else {
      el = doc.createElement("input");
      el.setAttribute("type", "text");
      el.value = current ?? "";
    }
    el.id = "voice";
    el.setAttribute("name", "voice");
    holder.appendChild(el);
  }

  function readForm() {
    return {
      baseUrl: $("baseUrl").value,
      apiKey: $("apiKey").value,
      model: $("model").value,
      voice: $("voice").value,
      speed: $("speed").value,
    };
  }

  function fillForm(s) {
    $("baseUrl").value = s.baseUrl;
    $("apiKey").value = s.apiKey;
    $("model").value = s.model;
    $("speed").value = String(s.speed);
    renderVoice(null, s.voice);
  }

  async function checkConnection(settings) {
    setText(status, "Checking connection…");
    const result = await listVoices(settings);
    if (result?.ok) {
      renderVoice(result.voices, settings.voice);
      setText(status, result.voices ? "Connection OK" : "Connection OK (the server lists no voices: type one)", "ok");
    } else {
      renderVoice(null, settings.voice);
      setText(status, `Connection failed: ${result?.error ?? "unknown error"}`, "error");
    }
  }

  async function save() {
    setText(message, "");
    const values = readForm();
    let origin;
    try {
      origin = permissionOrigin(values.baseUrl);
    } catch (err) {
      setText(message, `Not saved: ${err?.message || "invalid base URL"}`, "error");
      return;
    }
    // Request first, while the click still counts as a user gesture.
    if (origin) {
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) {
        setText(message, `Not saved: permission to reach ${origin} was denied.`, "error");
        return;
      }
    }
    const written = await saveSettings(chrome.storage.sync, values);
    $("speed").value = String(written.speed);
    setText(message, "Saved.", "ok");
    await checkConnection(await loadSettings(chrome.storage.sync));
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    page.saving = save();
  });
  // Tests the form's (possibly unsaved) values; a non-local URL needs its host permission first.
  async function testConnection(values, permission) {
    if (permission && !(await Promise.resolve(permission.request).catch(() => false))) {
      setText(status, `Connection not tested: permission to reach ${permission.origin} was denied.`, "error");
      return;
    }
    await checkConnection({ ...values, speed: clampSpeed(values.speed) });
  }

  $("test").addEventListener("click", () => {
    const values = readForm();
    let origin;
    try {
      origin = permissionOrigin(values.baseUrl);
    } catch (err) {
      setText(status, `Connection not tested: ${err?.message || "invalid base URL"}`, "error");
      page.saving = Promise.resolve();
      return;
    }
    // Requested synchronously, while the click still counts as a user gesture.
    const permission = origin && { origin, request: chrome.permissions.request({ origins: [`${origin}/*`] }) };
    page.saving = testConnection(values, permission);
  });

  page.ready = (async () => {
    const settings = await loadSettings(chrome?.storage?.sync);
    fillForm(settings);
    await checkConnection(settings);
  })();
  return page;
}

// Run only inside the extension's own page, not when imported by tests.
if (globalThis.document && globalThis.chrome?.runtime?.id) initOptions();
