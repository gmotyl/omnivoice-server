// Content script entry, bundled to dist/content.js and injected on demand by the service worker.
// Owns the reading session in the page: picks the source (article, selection, from-here),
// sends `play` with the sentences' pieces, follows `sentence-start` / `state` from the engine
// side, and maps player-bar actions and Alt+click to engine messages.

import { articleSentences, selectionSentences, sentenceIndexAt } from './source.mjs';
import * as nav from './nav.mjs';
import { createHighlighter } from './highlight.mjs';
import { createBar } from './bar.mjs';

// One controller per page, shared by every injection of the bundle.
export const CONTROLLER_KEY = Symbol.for('omnivoice-reader.controller');

const SETTINGS_DEFAULTS = { voice: '', speed: 1.0 };
const PLAYING = new Set(['playing', 'loading']);

function pageLang(doc, win) {
  return doc.documentElement.getAttribute('lang') || win.navigator?.language || undefined;
}

// Tags whose `src` the context menu reports as OnClickData.srcUrl.
const SRC_SELECTOR = 'img, video, audio, source, iframe, embed';

// deps: {doc, win, chrome, createBar, createHighlighter, listVoices}
// listVoices: async () => {ok, voices: string[] | null}, asked once per session to pick the
// first listed voice when none is stored. The default asks the service worker (`list-voices`):
// a content-script fetch would run with the page's origin (CORS, Local Network Access).
// Pass null to never ask.
export function createController({
  doc = globalThis.document,
  win = globalThis.window,
  chrome = globalThis.chrome,
  createBar: makeBar = createBar,
  createHighlighter: makeHighlighter = createHighlighter,
  listVoices,
} = {}) {
  let session = null;
  // Voice listing of the current session (shared by restarts inside it); reset on teardown.
  let voicesAsked = null;
  // Bumped by every teardown, so a stop that lands while start() awaits cancels that start.
  let startToken = 0;

  if (listVoices === undefined) {
    listVoices = () => Promise.resolve(chrome.runtime.sendMessage({ type: 'list-voices' }));
  }

  const send = (msg) => {
    try {
      return Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  };

  async function loadSettings() {
    try {
      const got = await chrome.storage?.sync?.get(SETTINGS_DEFAULTS);
      return { ...SETTINGS_DEFAULTS, ...(got || {}) };
    } catch {
      return { ...SETTINGS_DEFAULTS };
    }
  }

  async function askVoices() {
    if (!listVoices) return null;
    try {
      const res = await listVoices();
      return res && res.ok && Array.isArray(res.voices) ? res.voices : null;
    } catch {
      return null; // null = not known or the engine cannot list voices
    }
  }

  async function resolveVoice(stored) {
    voicesAsked ??= askVoices();
    const list = await voicesAsked;
    return { list, voice: stored || (list && list[0]) || '' };
  }

  // Context-menu "Read from here": OnClickData has no coordinates, only the clicked
  // link/image URL. Without one, the innermost hovered element is where the menu opened.
  function fromHereCandidates(msg) {
    const out = [];
    const matches = (el, attr, want) => {
      const raw = el.getAttribute(attr);
      if (!raw) return false;
      if (raw === want) return true;
      try {
        return new URL(raw, doc.baseURI || win.location?.href).href === want;
      } catch {
        return false;
      }
    };
    if (msg.linkUrl) {
      for (const a of doc.querySelectorAll('a[href]')) if (matches(a, 'href', msg.linkUrl)) out.push(a);
    }
    if (msg.srcUrl) {
      for (const el of doc.querySelectorAll(SRC_SELECTOR)) if (matches(el, 'src', msg.srcUrl)) out.push(el);
    }
    try {
      const hovered = doc.querySelectorAll(':hover');
      if (hovered.length) out.push(hovered[hovered.length - 1]);
    } catch {
      // :hover unsupported by this DOM
    }
    return out;
  }

  function pickSentences(msg) {
    const lang = pageLang(doc, win);
    const selection = win.getSelection?.();
    const hasSelection = !!(selection && selection.rangeCount && !selection.isCollapsed);
    if (msg.source === 'selection' || (msg.source === 'auto' && hasSelection)) {
      return { sentences: selectionSentences(doc, selection, lang), start: 0 };
    }
    const sentences = articleSentences(doc, lang);
    let start = 0;
    if (msg.source === 'from-here') {
      for (const el of fromHereCandidates(msg)) {
        const i = sentenceIndexAt(sentences, el);
        if (i >= 0) {
          start = i;
          break;
        }
      }
    }
    return { sentences, start };
  }

  function play(start) {
    const s = session;
    s.current = start;
    s.state = 'loading';
    s.bar.setState('loading');
    return send({
      type: 'play',
      sentences: s.sentences.map((x) => x.pieces),
      start,
      voice: s.voice,
      speed: s.speed,
    });
  }

  function seek(index) {
    if (!session) return undefined;
    // After the last sentence ended or an error the engine side has nothing to seek in.
    if (session.state === 'idle' || session.state === 'error') return play(index);
    session.current = index;
    return send({ type: 'seek', index });
  }

  function teardown() {
    startToken++;
    voicesAsked = null;
    if (!session) return;
    const s = session;
    session = null;
    doc.removeEventListener('click', s.onClick, true);
    s.highlighter.clear();
    s.bar.destroy();
  }

  function stop() {
    if (!session) return;
    send({ type: 'stop' });
    teardown();
  }

  function toggle() {
    if (!session) return undefined;
    if (PLAYING.has(session.state)) {
      session.state = 'paused';
      session.bar.setState('paused');
      return send({ type: 'pause' });
    }
    if (session.state === 'paused') {
      session.state = 'playing';
      session.bar.setState('playing');
      return send({ type: 'resume' });
    }
    return play(session.current);
  }

  function onAction(type, payload) {
    if (!session) return undefined;
    const { sentences, current } = session;
    switch (type) {
      case 'toggle':
        return toggle();
      case 'next': {
        const i = nav.next(sentences, current);
        return i === null ? stop() : seek(i);
      }
      case 'prev':
        return seek(nav.prev(sentences, current));
      case 'next-paragraph': {
        const i = nav.nextParagraph(sentences, current);
        return i === null ? stop() : seek(i);
      }
      case 'prev-paragraph':
        return seek(nav.prevParagraph(sentences, current));
      case 'speed':
        session.speed = payload;
        return send({ type: 'set-speed', speed: payload });
      case 'voice':
        session.voice = payload;
        return send({ type: 'set-voice', voice: payload });
      case 'retry':
        // "Nothing to read" has no sentences to replay: pick them again (the page may have rendered since).
        return sentences.length ? play(current) : start(session.startMsg);
      case 'options':
        // Content scripts cannot call chrome.runtime.openOptionsPage; the service worker does.
        return send({ type: 'open-options' });
      case 'close':
        return stop();
      default:
        return undefined;
    }
  }

  function createSession(voice, speed) {
    const s = {
      sentences: [],
      current: 0,
      state: 'idle',
      voice,
      speed,
      highlighter: makeHighlighter({ doc, win }),
      bar: null,
      onClick: null,
    };
    s.bar = makeBar({ doc, onAction });
    // Capture phase, so the page's own click handlers (links) do not run first.
    s.onClick = (e) => {
      if (!e.altKey || session !== s) return;
      const i = sentenceIndexAt(s.sentences, e.target);
      if (i < 0) return;
      e.preventDefault();
      e.stopPropagation?.();
      seek(i);
    };
    doc.addEventListener('click', s.onClick, true);
    return s;
  }

  async function start(msg) {
    const token = startToken;
    const settings = await loadSettings();
    if (token !== startToken) return;
    const { list, voice } = await resolveVoice(settings.voice);
    if (token !== startToken) return;
    const { sentences, start: from } = pickSentences(msg);

    // A new start while a session runs reuses its bar and listener.
    if (session) session.highlighter.clear();
    else session = createSession(voice, settings.speed);
    session.startMsg = msg;
    session.sentences = sentences;
    session.voice = voice;
    session.speed = settings.speed;
    session.bar.setVoices(list, voice);
    session.bar.setSpeed(settings.speed);
    if (!sentences.length) {
      session.state = 'error';
      session.bar.setState('error', 'Nothing to read on this page');
      return;
    }
    await play(from);
  }

  function handle(msg) {
    if (!msg || typeof msg.type !== 'string') return undefined;
    switch (msg.type) {
      case 'start':
        return start(msg);
      case 'toggle':
        return toggle();
      case 'stop':
        // Stopped from outside (another tab started, the tab navigates): no echo.
        return teardown();
      case 'sentence-start': {
        const s = session?.sentences[msg.index];
        if (!s) return undefined;
        session.current = msg.index;
        session.highlighter.show(s);
        return undefined;
      }
      case 'state':
        if (!session) return undefined;
        session.state = msg.state;
        session.bar.setState(msg.state, msg.error);
        if (msg.state === 'idle') session.highlighter.clear();
        return undefined;
      default:
        return undefined;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    handle(msg);
    return false;
  });

  return {
    handle,
    onAction,
    get session() {
      return session;
    },
  };
}

// Install once per page: a second injection of the bundle reuses the existing controller.
export function install(win = globalThis, deps = {}) {
  if (win[CONTROLLER_KEY]) return win[CONTROLLER_KEY];
  const controller = createController({ win, doc: win.document, chrome: win.chrome, ...deps });
  win[CONTROLLER_KEY] = controller;
  return controller;
}

// Bundle entry: runs only inside an extension content script, not when imported by tests.
if (globalThis.chrome?.runtime?.id && globalThis.document) install(globalThis);
