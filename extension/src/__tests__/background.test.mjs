import { test } from "node:test";
import assert from "node:assert/strict";
import { createBackground } from "../background.mjs";

function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    fire: (...args) => listeners.map((fn) => fn(...args)),
  };
}

// Minimal fake of the chrome.* surface the service worker uses; records every outgoing call.
function fakeChrome({ stored = {} } = {}) {
  const calls = { tabMessages: [], runtimeMessages: [], injected: [], menus: [], offscreenCreated: 0, optionsOpened: 0 };
  let offscreenOpen = false;
  const chrome = {
    calls,
    runtime: {
      onInstalled: event(),
      onMessage: event(),
      sendMessage: async (msg) => {
        calls.runtimeMessages.push(msg);
      },
      getContexts: async () => (offscreenOpen ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []),
      getURL: (p) => `chrome-extension://id/${p}`,
      openOptionsPage: async () => {
        calls.optionsOpened++;
      },
    },
    offscreen: {
      createDocument: async () => {
        await new Promise((r) => setTimeout(r, 5));
        calls.offscreenCreated++;
        offscreenOpen = true;
      },
    },
    action: { onClicked: event() },
    commands: { onCommand: event() },
    contextMenus: {
      onClicked: event(),
      create: (props) => calls.menus.push(props),
      removeAll: (cb) => {
        calls.menus.length = 0;
        cb?.();
      },
    },
    scripting: {
      executeScript: async (opts) => {
        calls.injected.push(opts);
      },
    },
    tabs: {
      onRemoved: event(),
      onUpdated: event(),
      sendMessage: async (tabId, msg) => {
        calls.tabMessages.push({ tabId, msg });
      },
    },
    storage: { sync: { get: async (defaults) => ({ ...defaults, ...stored }) } },
  };
  return chrome;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

// Delivers a runtime message as if it came from a content script in `tabId` (or from offscreen).
function deliver(chrome, msg, tabId) {
  const sender = tabId === undefined ? { url: "chrome-extension://id/src/offscreen.html" } : { tab: { id: tabId } };
  let response;
  const results = chrome.runtime.onMessage.fire(msg, sender, (r) => {
    response = r;
  });
  return { results, response: () => response };
}

const PLAY = { type: "play", sentences: [["One."], ["Two."]], start: 0, voice: "", speed: 1 };

test("creates both context menus on install", async () => {
  const chrome = fakeChrome();
  createBackground(chrome);
  chrome.runtime.onInstalled.fire({ reason: "install" });
  await tick();
  const byTitle = Object.fromEntries(chrome.calls.menus.map((m) => [m.title, m]));
  assert.deepEqual(byTitle["Read selection"].contexts, ["selection"]);
  assert.deepEqual([...byTitle["Read from here"].contexts].sort(), ["image", "link", "page"]);
});

test("action click injects content and sends start", async () => {
  const chrome = fakeChrome();
  createBackground(chrome);
  chrome.action.onClicked.fire({ id: 7 });
  await tick();
  assert.deepEqual(chrome.calls.injected, [{ target: { tabId: 7 }, files: ["dist/content.js"] }]);
  assert.deepEqual(chrome.calls.tabMessages, [{ tabId: 7, msg: { type: "start", source: "auto" } }]);

  // Menu items inject too and carry their source; from-here carries the clicked link/image.
  chrome.contextMenus.onClicked.fire({ menuItemId: "read-selection" }, { id: 7 });
  chrome.contextMenus.onClicked.fire(
    { menuItemId: "read-from-here", linkUrl: "https://a.example/x", srcUrl: "https://a.example/i.png" },
    { id: 8 },
  );
  await tick();
  assert.equal(chrome.calls.injected.length, 3);
  assert.deepEqual(chrome.calls.tabMessages.slice(1), [
    { tabId: 7, msg: { type: "start", source: "selection" } },
    {
      tabId: 8,
      msg: { type: "start", source: "from-here", linkUrl: "https://a.example/x", srcUrl: "https://a.example/i.png" },
    },
  ]);
});

test("shortcut toggles an existing session", async () => {
  const chrome = fakeChrome();
  createBackground(chrome);
  // No session anywhere yet: the shortcut starts one.
  chrome.commands.onCommand.fire("toggle-reading", { id: 3 });
  await tick();
  assert.deepEqual(chrome.calls.tabMessages, [{ tabId: 3, msg: { type: "start", source: "auto" } }]);

  deliver(chrome, PLAY, 3);
  await tick();
  chrome.calls.tabMessages.length = 0;
  chrome.calls.injected.length = 0;

  chrome.commands.onCommand.fire("toggle-reading", { id: 3 });
  await tick();
  assert.deepEqual(chrome.calls.tabMessages, [{ tabId: 3, msg: { type: "toggle" } }]);
  assert.equal(chrome.calls.injected.length, 0);
});

test("play creates the offscreen document once", async () => {
  const chrome = fakeChrome({ stored: { baseUrl: "http://localhost:9000/v1", apiKey: "k", voice: "v0" } });
  createBackground(chrome);
  deliver(chrome, PLAY, 1);
  deliver(chrome, { ...PLAY, start: 1 }, 1);
  await tick();
  assert.equal(chrome.calls.offscreenCreated, 1);
  const plays = chrome.calls.runtimeMessages.filter((m) => m.type === "play");
  assert.equal(plays.length, 2);
  assert.equal(plays[0].target, "offscreen");
  assert.deepEqual(plays[0].sentences, PLAY.sentences);
  assert.deepEqual(plays[0].settings, { baseUrl: "http://localhost:9000/v1", apiKey: "k", model: "tts-1" });
  assert.equal(plays[1].start, 1);

  // Controls from the owning tab are relayed to offscreen too.
  deliver(chrome, { type: "seek", index: 1 }, 1);
  deliver(chrome, { type: "set-speed", speed: 1.5 }, 1);
  await tick();
  const relayed = chrome.calls.runtimeMessages.slice(2);
  assert.deepEqual(
    relayed.map((m) => [m.type, m.target]),
    [
      ["seek", "offscreen"],
      ["set-speed", "offscreen"],
    ],
  );

  // A relayed copy (target offscreen) reaching the worker is not relayed again.
  const before = chrome.calls.runtimeMessages.length;
  deliver(chrome, { type: "seek", index: 0, target: "offscreen" });
  await tick();
  assert.equal(chrome.calls.runtimeMessages.length, before);
});

test("second tab stops the first session", async () => {
  const chrome = fakeChrome();
  createBackground(chrome);
  deliver(chrome, PLAY, 1);
  await tick();
  chrome.calls.tabMessages.length = 0;

  // Record the order of the stop to tab 1 and the play forwarded for tab 2.
  const order = [];
  const sendTab = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (tabId, msg) => {
    order.push(`tab${tabId}:${msg.type}`);
    return sendTab(tabId, msg);
  };
  const sendRuntime = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = async (msg) => {
    order.push(`offscreen:${msg.type}`);
    return sendRuntime(msg);
  };
  deliver(chrome, PLAY, 2);
  await tick();
  assert.deepEqual(order, ["tab1:stop", "offscreen:play"]);

  // Tab 1's controls no longer reach the player.
  deliver(chrome, { type: "pause" }, 1);
  await tick();
  assert.equal(order.length, 2);
});

test("tab reload or close stops playback", async () => {
  const chrome = fakeChrome();
  createBackground(chrome);
  deliver(chrome, PLAY, 4);
  await tick();
  const stops = () => chrome.calls.runtimeMessages.filter((m) => m.type === "stop");

  // Another tab or a non-loading update changes nothing.
  chrome.tabs.onUpdated.fire(5, { status: "loading" });
  chrome.tabs.onUpdated.fire(4, { title: "x" });
  await tick();
  assert.equal(stops().length, 0);

  chrome.tabs.onUpdated.fire(4, { status: "loading" });
  await tick();
  assert.equal(stops().length, 1);
  assert.equal(stops()[0].target, "offscreen");

  deliver(chrome, PLAY, 4);
  await tick();
  chrome.tabs.onRemoved.fire(4, {});
  await tick();
  assert.equal(stops().length, 2);

  // Ownership is gone: the shortcut on that tab starts afresh instead of toggling.
  chrome.commands.onCommand.fire("toggle-reading", { id: 4 });
  await tick();
  assert.deepEqual(chrome.calls.tabMessages.at(-1), { tabId: 4, msg: { type: "start", source: "auto" } });
});

test("offscreen events go to the owning tab only", async () => {
  const chrome = fakeChrome();
  createBackground(chrome);
  deliver(chrome, PLAY, 1);
  await tick();
  deliver(chrome, PLAY, 2);
  await tick();
  chrome.calls.tabMessages.length = 0;

  deliver(chrome, { type: "sentence-start", index: 1 });
  deliver(chrome, { type: "state", state: "playing" });
  await tick();
  assert.deepEqual(chrome.calls.tabMessages, [
    { tabId: 2, msg: { type: "sentence-start", index: 1 } },
    { tabId: 2, msg: { type: "state", state: "playing" } },
  ]);
  // Nothing from offscreen is sent back to the runtime (no loop).
  assert.equal(chrome.calls.runtimeMessages.filter((m) => m.type === "state").length, 0);

  // A content script echoing an offscreen-only event type is ignored.
  chrome.calls.tabMessages.length = 0;
  deliver(chrome, { type: "state", state: "idle" }, 1);
  await tick();
  assert.deepEqual(chrome.calls.tabMessages, []);

  // list-voices answers asynchronously; open-options opens the options page.
  const fetchCalls = [];
  const chrome2 = fakeChrome();
  createBackground(chrome2, {
    listVoices: async (settings) => {
      fetchCalls.push(settings);
      return { ok: true, voices: ["a", "b"] };
    },
  });
  const { results, response } = deliver(chrome2, { type: "list-voices" }, 9);
  assert.equal(results[0], true);
  await tick();
  assert.deepEqual(response(), { ok: true, voices: ["a", "b"] });
  assert.equal(fetchCalls[0].baseUrl, "http://localhost:8892/v1");
  deliver(chrome2, { type: "open-options" }, 9);
  await tick();
  assert.equal(chrome2.calls.optionsOpened, 1);
});
