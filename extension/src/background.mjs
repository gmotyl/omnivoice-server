// Service worker: triggers (action, shortcut, context menus), on-demand content injection,
// single-session ownership and message routing between the owning tab and the offscreen document.
//
// Routing: content scripts send with chrome.runtime.sendMessage (sender.tab set); the worker
// re-sends engine commands to offscreen stamped `target: "offscreen"`. The offscreen document acts
// only on stamped copies, and this worker ignores them, so nothing is handled twice or loops.
// Offscreen's `sentence-start` / `state` (no sender.tab) go only to the owning tab.
import { listVoices as engineListVoices } from "./engine.mjs";
import { loadSettings as loadStoredSettings } from "./settings.mjs";

export const OFFSCREEN_URL = "src/offscreen.html";
export const CONTENT_FILE = "dist/content.js";
export const MENU_SELECTION = "read-selection";
export const MENU_FROM_HERE = "read-from-here";

const RELAYED = new Set(["seek", "pause", "resume", "stop", "set-speed", "set-voice"]);
const FROM_OFFSCREEN = new Set(["sentence-start", "state"]);
const OWNER_KEY = "ownerTabId";

// deps: {listVoices, loadSettings} — injectable for tests.
export function createBackground(chrome, deps = {}) {
  const listVoices = deps.listVoices ?? engineListVoices;
  const loadSettings = deps.loadSettings ?? (() => loadStoredSettings(chrome.storage?.sync));

  // The worker can be suspended mid-session (e.g. while paused); the owner is mirrored to
  // storage.session so a restarted worker still routes to the right tab.
  let owner; // undefined = not loaded yet, null = no session
  let ownerLoading = null;
  const sessionStore = chrome.storage?.session;

  function getOwner() {
    if (owner !== undefined) return Promise.resolve(owner);
    ownerLoading ??= Promise.resolve()
      .then(() => sessionStore?.get?.(OWNER_KEY))
      .catch(() => undefined)
      .then((got) => {
        if (owner === undefined) owner = got?.[OWNER_KEY] ?? null;
        return owner;
      });
    return ownerLoading;
  }

  function setOwner(tabId) {
    owner = tabId;
    try {
      Promise.resolve(sessionStore?.set?.({ [OWNER_KEY]: tabId })).catch(() => {});
    } catch {
      // storage.session unavailable: in-memory ownership only
    }
  }

  const ignore = () => {};
  const toTab = (tabId, msg) => {
    try {
      return Promise.resolve(chrome.tabs.sendMessage(tabId, msg)).catch(ignore);
    } catch {
      return Promise.resolve();
    }
  };
  const toOffscreen = (msg) => {
    try {
      return Promise.resolve(chrome.runtime.sendMessage({ ...msg, target: "offscreen" })).catch(ignore);
    } catch {
      return Promise.resolve();
    }
  };

  let creating = null;
  async function ensureOffscreen() {
    if (creating) return creating;
    creating = (async () => {
      const contexts = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      if (contexts?.length) return;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Plays the synthesized speech of the page being read.",
      });
    })().finally(() => {
      creating = null;
    });
    return creating;
  }

  async function startIn(tabId, start) {
    if (tabId === undefined || tabId === null) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE] });
    } catch {
      // Restricted pages (chrome://, the web store) cannot be scripted; nothing to read there.
      return;
    }
    await toTab(tabId, { type: "start", ...start });
  }

  async function stopOffscreen() {
    setOwner(null);
    await toOffscreen({ type: "stop" });
  }

  async function onPlay(msg, tabId) {
    const current = await getOwner();
    if (current !== null && current !== tabId) await toTab(current, { type: "stop" });
    setOwner(tabId);
    const [settings] = await Promise.all([loadSettings(), ensureOffscreen()]);
    // Another tab took over while settings / the offscreen document were loading.
    if (owner !== tabId) return;
    const { baseUrl, apiKey, model } = settings;
    await toOffscreen({ ...msg, tabId, settings: { baseUrl, apiKey, model } });
  }

  async function onControl(msg, tabId) {
    if ((await getOwner()) !== tabId) return;
    if (msg.type === "stop") setOwner(null);
    await toOffscreen({ ...msg, tabId });
  }

  async function onOffscreenEvent(msg) {
    const tabId = await getOwner();
    if (tabId !== null) await toTab(tabId, msg);
  }

  chrome.runtime.onInstalled.addListener(() => {
    const create = () => {
      chrome.contextMenus.create({ id: MENU_SELECTION, title: "Read selection", contexts: ["selection"] });
      chrome.contextMenus.create({ id: MENU_FROM_HERE, title: "Read from here", contexts: ["page", "link", "image"] });
    };
    // removeAll first: updates and reloads would otherwise hit duplicate ids.
    if (chrome.contextMenus.removeAll) chrome.contextMenus.removeAll(create);
    else create();
  });

  chrome.action.onClicked.addListener((tab) => {
    void startIn(tab?.id, { source: "auto" });
  });

  chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command !== "toggle-reading" || tab?.id === undefined) return;
    if ((await getOwner()) === tab.id) await toTab(tab.id, { type: "toggle" });
    else await startIn(tab.id, { source: "auto" });
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_SELECTION) return void startIn(tab?.id, { source: "selection" });
    if (info.menuItemId !== MENU_FROM_HERE) return;
    // OnClickData has no coordinates; the content script resolves the clicked link/image itself.
    const start = { source: "from-here" };
    if (info.linkUrl) start.linkUrl = info.linkUrl;
    if (info.srcUrl) start.srcUrl = info.srcUrl;
    void startIn(tab?.id, start);
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    if ((await getOwner()) === tabId) await stopOffscreen();
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo?.status !== "loading") return;
    if ((await getOwner()) === tabId) await stopOffscreen();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Stamped copies are this worker's own relays, meant for the offscreen document.
    if (!msg || typeof msg.type !== "string" || msg.target === "offscreen") return false;
    const tabId = sender?.tab?.id;
    if (tabId === undefined) {
      // Extension pages (the offscreen document): only its progress events are routed.
      if (FROM_OFFSCREEN.has(msg.type)) void onOffscreenEvent(msg);
      return false;
    }
    switch (msg.type) {
      case "list-voices":
        Promise.resolve()
          .then(() => loadSettings())
          .then((settings) => listVoices(settings))
          .then(sendResponse, (err) => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true; // keeps the channel open for the async answer
      case "open-options":
        Promise.resolve()
          .then(() => chrome.runtime.openOptionsPage())
          .catch(ignore);
        return false;
      case "play":
        void onPlay(msg, tabId);
        return false;
      default:
        if (RELAYED.has(msg.type)) void onControl(msg, tabId);
        return false;
    }
  });
}

// Real service worker: listeners must be registered synchronously at top level.
if (typeof ServiceWorkerGlobalScope !== "undefined" && globalThis.chrome?.runtime?.id) {
  createBackground(globalThis.chrome);
}
