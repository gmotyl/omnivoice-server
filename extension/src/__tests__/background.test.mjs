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
// `session` (a plain object) backs a fake chrome.storage.session shared across workers.
function fakeChrome({ stored = {}, session } = {}) {
  const calls = { tabMessages: [], runtimeMessages: [], injected: [], menus: [], offscreenCreated: 0, optionsOpened: 0 };
  let offscreenOpen = false;
  const chrome = {
    calls,
    // Simulates Chrome closing an idle AUDIO_PLAYBACK document (~30 s without audio).
    closeOffscreen: () => {
      offscreenOpen = false;
    },
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
  if (session) {
    chrome.storage.session = {
      get: async (key) => (key in session ? { [key]: structuredClone(session[key]) } : {}),
      set: async (items) => {
        for (const [k, v] of Object.entries(items)) session[k] = structuredClone(v);
      },
    };
  }
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
  // Concurrent plays from one tab: only the newest is forwarded.
  const plays = chrome.calls.runtimeMessages.filter((m) => m.type === "play");
  assert.equal(plays.length, 1);
  assert.equal(plays[0].target, "offscreen");
  assert.deepEqual(plays[0].sentences, PLAY.sentences);
  assert.deepEqual(plays[0].settings, { baseUrl: "http://localhost:9000/v1", apiKey: "k", model: "tts-1" });
  assert.equal(plays[0].start, 1);

  // Controls from the owning tab are relayed to offscreen too.
  deliver(chrome, { type: "seek", index: 1 }, 1);
  deliver(chrome, { type: "set-speed", speed: 1.5 }, 1);
  await tick();
  const relayed = chrome.calls.runtimeMessages.slice(1);
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

const plays = (chrome) => chrome.calls.runtimeMessages.filter((m) => m.type === "play");

// Starts a session in tab 1, reports progress to sentence `index`, then pauses and lets Chrome
// close the offscreen document.
async function pausedAndClosed(chrome, index = 1) {
  deliver(chrome, { ...PLAY, sentences: [["One."], ["Two."], ["Three."]] }, 1);
  await tick();
  deliver(chrome, { type: "state", state: "playing" });
  deliver(chrome, { type: "sentence-start", index });
  deliver(chrome, { type: "pause" }, 1);
  await tick();
  deliver(chrome, { type: "state", state: "paused" });
  await tick();
  chrome.closeOffscreen();
}

test("resume after the offscreen document closed replays from the current sentence", async () => {
  const chrome = fakeChrome({ stored: { apiKey: "k" } });
  createBackground(chrome);
  await pausedAndClosed(chrome, 1);
  chrome.calls.runtimeMessages.length = 0;

  deliver(chrome, { type: "resume" }, 1);
  await tick();
  assert.equal(chrome.calls.offscreenCreated, 2);
  assert.equal(plays(chrome).length, 1);
  const replay = plays(chrome)[0];
  assert.equal(replay.target, "offscreen");
  assert.equal(replay.start, 1);
  assert.equal(replay.tabId, 1);
  assert.deepEqual(replay.sentences, [["One."], ["Two."], ["Three."]]);
  assert.equal(replay.settings.apiKey, "k");
  // The resume itself would go nowhere; only the replay is sent.
  assert.equal(chrome.calls.runtimeMessages.filter((m) => m.type === "resume").length, 0);

  // With the document alive again, controls are relayed as usual.
  chrome.calls.runtimeMessages.length = 0;
  deliver(chrome, { type: "pause" }, 1);
  deliver(chrome, { type: "resume" }, 1);
  await tick();
  assert.deepEqual(
    chrome.calls.runtimeMessages.map((m) => m.type),
    ["pause", "resume"],
  );
});

test("seek after the offscreen document closed replays from the target", async () => {
  const chrome = fakeChrome();
  createBackground(chrome);
  await pausedAndClosed(chrome, 0);
  chrome.calls.runtimeMessages.length = 0;

  deliver(chrome, { type: "seek", index: 2 }, 1);
  await tick();
  assert.equal(plays(chrome).length, 1);
  assert.equal(plays(chrome)[0].start, 2);
  assert.equal(chrome.calls.runtimeMessages.filter((m) => m.type === "seek").length, 0);
});

test("voice or speed change while closed and paused applies on the next resume", async () => {
  const chrome = fakeChrome();
  createBackground(chrome);
  await pausedAndClosed(chrome, 1);
  chrome.calls.runtimeMessages.length = 0;

  deliver(chrome, { type: "set-voice", voice: "v2" }, 1);
  deliver(chrome, { type: "set-speed", speed: 1.5 }, 1);
  await tick();
  // Paused: nothing starts playing, the document is not recreated.
  assert.equal(chrome.calls.runtimeMessages.length, 0);
  assert.equal(chrome.calls.offscreenCreated, 1);

  deliver(chrome, { type: "resume" }, 1);
  await tick();
  assert.equal(plays(chrome).length, 1);
  assert.equal(plays(chrome)[0].voice, "v2");
  assert.equal(plays(chrome)[0].speed, 1.5);
  assert.equal(plays(chrome)[0].start, 1);
});

test("voice change while closed and playing replays from the current sentence", async () => {
  const chrome = fakeChrome();
  createBackground(chrome);
  deliver(chrome, PLAY, 1);
  await tick();
  deliver(chrome, { type: "state", state: "playing" });
  deliver(chrome, { type: "sentence-start", index: 1 });
  await tick();
  chrome.closeOffscreen();
  chrome.calls.runtimeMessages.length = 0;

  deliver(chrome, { type: "set-voice", voice: "v3" }, 1);
  await tick();
  assert.equal(plays(chrome).length, 1);
  assert.equal(plays(chrome)[0].voice, "v3");
  assert.equal(plays(chrome)[0].start, 1);
});

test("a restarted worker still replays after the offscreen document closed", async () => {
  const session = {};
  const first = fakeChrome({ session });
  createBackground(first);
  await pausedAndClosed(first, 2);

  // Fresh worker instance, same storage.session; the offscreen document is gone.
  const chrome = fakeChrome({ session });
  createBackground(chrome);
  deliver(chrome, { type: "resume" }, 1);
  await tick();
  assert.equal(plays(chrome).length, 1);
  assert.equal(plays(chrome)[0].start, 2);
  assert.deepEqual(plays(chrome)[0].sentences, [["One."], ["Two."], ["Three."]]);
});

test("stop forgets the session so a later resume replays nothing", async () => {
  const chrome = fakeChrome();
  createBackground(chrome);
  await pausedAndClosed(chrome, 1);
  deliver(chrome, { type: "stop" }, 1);
  await tick();
  chrome.calls.runtimeMessages.length = 0;
  deliver(chrome, { type: "resume" }, 1);
  await tick();
  assert.equal(plays(chrome).length, 0);
});

test("play failure reports an error state to the tab", async () => {
  const chrome = fakeChrome();
  chrome.offscreen.createDocument = async () => {
    throw new Error("offscreen refused");
  };
  createBackground(chrome);
  deliver(chrome, PLAY, 6);
  await tick();
  assert.deepEqual(chrome.calls.tabMessages, [
    { tabId: 6, msg: { type: "state", state: "error", error: "offscreen refused" } },
  ]);
  assert.equal(plays(chrome).length, 0);
});

test("a tab that lost ownership while the document loaded does not play", async () => {
  const chrome = fakeChrome();
  createBackground(chrome);
  deliver(chrome, PLAY, 1);
  // Tab 2 takes over while tab 1's offscreen document is still being created (5 ms).
  await new Promise((r) => setTimeout(r, 1));
  deliver(chrome, { ...PLAY, start: 1 }, 2);
  await tick();
  assert.deepEqual(
    plays(chrome).map((m) => m.tabId),
    [2],
  );
});

test("a slower earlier play from the same tab is dropped after a newer one", async () => {
  const chrome = fakeChrome();
  // The first settings load is slow, the second fast: the older play completes last.
  const delays = [30, 0];
  createBackground(chrome, {
    loadSettings: async () => {
      await new Promise((r) => setTimeout(r, delays.shift() ?? 0));
      return { baseUrl: "http://localhost:9000/v1", apiKey: "k", model: "tts-1" };
    },
  });
  deliver(chrome, { ...PLAY, start: 0 }, 1);
  await new Promise((r) => setTimeout(r, 1));
  deliver(chrome, { ...PLAY, start: 1 }, 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(
    plays(chrome).map((m) => m.start),
    [1],
  );
});

test("a stale play waiting on the stop to the owner does not take ownership from a newer play", async () => {
  const chrome = fakeChrome();
  createBackground(chrome);
  deliver(chrome, { ...PLAY, start: 0 }, 1);
  await tick();
  chrome.calls.runtimeMessages.length = 0;
  // The stop sent to tab 1 is slow, so tab 2's play is still awaiting it when tab 1 plays again.
  const sendTab = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (tabId, msg) => {
    if (msg.type === "stop") await new Promise((r) => setTimeout(r, 30));
    return sendTab(tabId, msg);
  };
  deliver(chrome, { ...PLAY, start: 5 }, 2);
  await new Promise((r) => setTimeout(r, 1));
  deliver(chrome, { ...PLAY, start: 7 }, 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(
    plays(chrome).map((m) => [m.tabId, m.start]),
    [[1, 7]],
  );
  // Tab 1 still owns the session: its controls reach the player.
  deliver(chrome, { type: "pause" }, 1);
  await tick();
  assert.ok(chrome.calls.runtimeMessages.some((m) => m.type === "pause" && m.tabId === 1));
});
