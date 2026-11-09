import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createController, install } from '../main.mjs';
import { createBar } from '../bar.mjs';
import { installTextRange } from './fake-range.mjs';

const longParagraph = (n) =>
  `<p id="p${n}">Paragraph ${n} talks about the topic at length, with commas, details, and more words so that it scores well. ` +
  `It keeps going for a while longer here, adding context, examples, and some plain filler text.</p>`;

const PAGE = `
  <nav><a href="/">Home</a> <a href="/about">About us</a></nav>
  <main><article id="art"><h1>Title of the article</h1>
    ${[1, 2, 3, 4, 5, 6].map(longParagraph).join('\n')}
  </article></main>
  <footer><p>Copyright notice.</p></footer>`;

function fakeSelection(startNode, startOffset, endNode, endOffset) {
  const range = { startContainer: startNode, startOffset, endContainer: endNode, endOffset };
  const ancestors = new Set();
  for (let n = startNode; n; n = n.parentNode) ancestors.add(n);
  let common = endNode;
  while (common && !ancestors.has(common)) common = common.parentNode;
  range.commonAncestorContainer = common;
  return { rangeCount: 1, isCollapsed: false, getRangeAt: () => range };
}

function fakeChrome(stored = {}) {
  const sent = [];
  const listeners = [];
  return {
    sent,
    listeners,
    runtime: {
      id: 'test',
      sendMessage: async (msg) => {
        sent.push(msg);
      },
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
      },
    },
    stored,
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, ...stored }),
        set: async (obj) => {
          Object.assign(stored, obj);
        },
      },
    },
  };
}

function setup({ selection = null, stored = {}, listVoices = null, page = PAGE } = {}) {
  const { document, window } = parseHTML(
    `<!doctype html><html lang="en"><head><title>Test</title></head><body>${page}</body></html>`,
  );
  installTextRange(document);
  // Count the controller's capture-phase click listeners, so a missing removeEventListener shows.
  const clickListeners = new Set();
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  document.addEventListener = (type, fn, opts) => {
    if (type === 'click') clickListeners.add(fn);
    return add(type, fn, opts);
  };
  document.removeEventListener = (type, fn, opts) => {
    if (type === 'click') clickListeners.delete(fn);
    return remove(type, fn, opts);
  };
  const chrome = fakeChrome(stored);
  const win = {
    document,
    chrome,
    navigator: { language: 'en-US' },
    getSelection: () => selection?.(document),
    innerHeight: 800,
    innerWidth: 1200,
  };
  const highlights = [];
  const highlighter = {
    shown: null,
    show(s, opts) {
      this.shown = s;
      this.opts = opts;
      highlights.push(s);
    },
    clear() {
      this.shown = null;
      highlights.push(null);
    },
  };
  const bars = [];
  const makeBar = (opts) => {
    const bar = createBar(opts);
    const states = [];
    const wrapped = {
      ...bar,
      states,
      action: opts.onAction,
      setState: (s, e) => {
        states.push(s);
        bar.setState(s, e);
      },
    };
    bars.push(wrapped);
    return wrapped;
  };
  const deps = { createBar: makeBar, createHighlighter: () => highlighter, listVoices };
  return { document, window, win, chrome, highlighter, highlights, bars, deps, clickListeners };
}

const barHosts = (doc) => doc.querySelectorAll('[data-omnivoice-reader="bar"]').length;
const ofType = (sent, type) => sent.filter((m) => m.type === type);

function altClick(document, el) {
  const ev = new document.defaultView.Event('click', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'altKey', { value: true });
  el.dispatchEvent(ev);
  return ev;
}

async function started(opts, startMsg = { type: 'start', source: 'auto' }) {
  const t = setup(opts);
  const c = install(t.win, t.deps);
  await c.handle(startMsg);
  return { ...t, c };
}

test('auto start reads the article from the first sentence', async () => {
  const { chrome, document, c } = await started({ stored: { voice: 'alba', speed: 1.2 } });
  const [play] = ofType(chrome.sent, 'play');
  assert.ok(play, 'play sent');
  assert.equal(play.start, 0);
  assert.equal(play.voice, 'alba');
  assert.equal(play.speed, 1.2);
  assert.ok(play.sentences.every((s) => Array.isArray(s) && s.every((p) => typeof p === 'string')));
  assert.match(play.sentences[0][0], /Title of the article/);
  assert.ok(!play.sentences.flat().some((p) => /Copyright|About us/.test(p)));
  assert.equal(play.sentences.length, c.session.sentences.length);
  assert.equal(barHosts(document), 1);
});

test('selection start reads only the selection', async () => {
  const selection = (doc) => {
    const text = doc.getElementById('p2').firstChild;
    return fakeSelection(text, 0, text, text.data.indexOf('It keeps'));
  };
  for (const source of ['selection', 'auto']) {
    const { chrome } = await started({ selection }, { type: 'start', source });
    const [play] = ofType(chrome.sent, 'play');
    assert.equal(play.start, 0);
    assert.equal(play.sentences.length, 1, source);
    assert.match(play.sentences[0][0], /^Paragraph 2 talks/);
  }
});

test('from-here starts at the paragraph under the point', async () => {
  // The context menu reports the clicked link: start at the paragraph holding it.
  const t = setup();
  const a = t.document.createElement('a');
  a.setAttribute('href', 'https://example.com/more');
  a.textContent = 'more';
  t.document.getElementById('p4').appendChild(a);
  const c = install(t.win, t.deps);
  await c.handle({ type: 'start', source: 'from-here', linkUrl: 'https://example.com/more' });
  const [play] = ofType(t.chrome.sent, 'play');
  assert.match(play.sentences[play.start][0], /^Paragraph 4 talks/);

  // A plain page right-click has no link: the innermost hovered element decides.
  const t2 = setup();
  const qsa = t2.document.querySelectorAll.bind(t2.document);
  t2.document.querySelectorAll = (sel) =>
    sel === ':hover'
      ? [t2.document.documentElement, t2.document.body, t2.document.getElementById('art'), t2.document.getElementById('p3')]
      : qsa(sel);
  const c2 = install(t2.win, t2.deps);
  await c2.handle({ type: 'start', source: 'from-here' });
  const [play2] = ofType(t2.chrome.sent, 'play');
  assert.match(play2.sentences[play2.start][0], /^Paragraph 3 talks/);

  // nothing resolvable → falls back to the first sentence
  const t3 = setup();
  const c3 = install(t3.win, t3.deps);
  await c3.handle({ type: 'start', source: 'from-here', srcUrl: 'https://example.com/missing.png' });
  assert.equal(ofType(t3.chrome.sent, 'play')[0].start, 0);
});

test('from-here resolves a clicked image by srcUrl', async () => {
  const t = setup();
  const img = t.document.createElement('img');
  img.setAttribute('src', 'https://example.com/pic.png');
  t.document.getElementById('p5').appendChild(img);
  const c = install(t.win, t.deps);
  await c.handle({ type: 'start', source: 'from-here', srcUrl: 'https://example.com/pic.png' });
  const [play] = ofType(t.chrome.sent, 'play');
  assert.match(play.sentences[play.start][0], /^Paragraph 5 talks/);
});

test('alt+click seeks to the paragraph start', async () => {
  const { chrome, document, c } = await started();
  c.handle({ type: 'state', state: 'playing' });
  const p5 = document.getElementById('p5');
  const ev = altClick(document, p5.firstChild.parentElement);
  assert.equal(ev.defaultPrevented, true);
  const [seek] = ofType(chrome.sent, 'seek');
  assert.ok(seek, 'seek sent');
  assert.match(c.session.sentences[seek.index].text, /^Paragraph 5 talks/);

  // a plain click is left alone
  const plain = new document.defaultView.Event('click', { bubbles: true, cancelable: true });
  p5.dispatchEvent(plain);
  assert.equal(plain.defaultPrevented, false);
  assert.equal(ofType(chrome.sent, 'seek').length, 1);
});

test('sentence-start moves the highlight', async () => {
  const { highlighter, c } = await started();
  c.handle({ type: 'sentence-start', index: 2 });
  assert.equal(highlighter.shown, c.session.sentences[2]);
  c.handle({ type: 'sentence-start', index: 3 });
  assert.equal(highlighter.shown, c.session.sentences[3]);
});

test('bar actions map to engine messages', async () => {
  const { chrome, bars, c } = await started();
  const act = bars[0].action;
  const last = () => chrome.sent.at(-1);
  const n = c.session.sentences.length;
  const paraStart = c.session.sentences.findIndex((s) => s.paragraph === 1);
  c.handle({ type: 'state', state: 'playing' });

  c.handle({ type: 'sentence-start', index: 0 });
  act('next');
  assert.deepEqual(last(), { type: 'seek', index: 1 });
  c.handle({ type: 'sentence-start', index: 1 });
  act('prev');
  assert.deepEqual(last(), { type: 'seek', index: 0 });
  c.handle({ type: 'sentence-start', index: 0 });
  act('next-paragraph');
  assert.deepEqual(last(), { type: 'seek', index: paraStart });
  c.handle({ type: 'sentence-start', index: paraStart + 1 });
  act('prev-paragraph');
  assert.deepEqual(last(), { type: 'seek', index: paraStart });

  act('toggle');
  assert.deepEqual(last(), { type: 'pause' });
  act('toggle');
  assert.deepEqual(last(), { type: 'resume' });
  act('speed', 1.3);
  assert.deepEqual(last(), { type: 'set-speed', speed: 1.3 });
  act('voice', 'bob');
  assert.deepEqual(last(), { type: 'set-voice', voice: 'bob' });

  c.handle({ type: 'sentence-start', index: n - 1 });
  act('next');
  assert.deepEqual(last(), { type: 'stop' });
  assert.equal(c.session, null);

  // close sends stop
  const t = await started();
  t.bars[0].action('close');
  assert.deepEqual(t.chrome.sent.at(-1), { type: 'stop' });
});

test('toggle pauses and resumes', async () => {
  const { chrome, c, bars } = await started();
  c.handle({ type: 'state', state: 'playing' });
  c.handle({ type: 'toggle' });
  assert.deepEqual(chrome.sent.at(-1), { type: 'pause' });
  assert.equal(bars[0].states.at(-1), 'paused');
  c.handle({ type: 'toggle' });
  assert.deepEqual(chrome.sent.at(-1), { type: 'resume' });
  assert.equal(bars[0].states.at(-1), 'playing');
});

test('stop tears down bar, highlight and listeners', async () => {
  for (const how of ['message', 'close']) {
    const { chrome, document, highlighter, bars, c, clickListeners } = await started();
    c.handle({ type: 'sentence-start', index: 1 });
    assert.equal(clickListeners.size, 1, how);
    if (how === 'message') c.handle({ type: 'stop' });
    else bars[0].action('close');
    assert.equal(clickListeners.size, 0, `${how}: click listener removed`);
    assert.equal(highlighter.shown, null, how);
    assert.equal(barHosts(document), 0, how);
    assert.equal(c.session, null, how);
    const before = chrome.sent.length;
    const ev = altClick(document, document.getElementById('p3'));
    assert.equal(ev.defaultPrevented, false, how);
    assert.equal(chrome.sent.length, before, how);
  }
});

test('double injection keeps one session', async () => {
  const t = setup();
  const first = install(t.win, t.deps);
  const second = install(t.win, t.deps);
  assert.equal(first, second);
  assert.equal(t.chrome.listeners.length, 1);
  await first.handle({ type: 'start', source: 'auto' });
  await second.handle({ type: 'start', source: 'auto' });
  assert.equal(barHosts(t.document), 1);
  assert.equal(t.bars.length, 1);
  assert.equal(ofType(t.chrome.sent, 'play').length, 2);
});

test('empty stored voice uses the first listed voice, asked once', async () => {
  let calls = 0;
  const listVoices = async () => {
    calls++;
    return { ok: true, voices: ['first', 'second'] };
  };
  const t = setup({ listVoices });
  const c = createController({ ...t.deps, doc: t.document, win: t.win, chrome: t.chrome });
  await c.handle({ type: 'start', source: 'auto' });
  await c.handle({ type: 'start', source: 'auto' });
  assert.equal(calls, 1);
  assert.ok(ofType(t.chrome.sent, 'play').every((p) => p.voice === 'first'));
});

test('natural end keeps alt+click, which starts reading again there', async () => {
  const { chrome, document, c, clickListeners } = await started();
  c.handle({ type: 'state', state: 'playing' });
  c.handle({ type: 'state', state: 'idle' });
  assert.equal(clickListeners.size, 1, 'listener kept after the last sentence ended');
  const before = ofType(chrome.sent, 'play').length;
  const ev = altClick(document, document.getElementById('p6'));
  assert.equal(ev.defaultPrevented, true);
  const plays = ofType(chrome.sent, 'play');
  assert.equal(plays.length, before + 1);
  assert.match(plays.at(-1).sentences[plays.at(-1).start][0], /^Paragraph 6 talks/);
});

test('stop during start does not start a session', async () => {
  let release;
  const listVoices = () => new Promise((r) => (release = r));
  const t = setup({ listVoices });
  const c = install(t.win, t.deps);
  const starting = c.handle({ type: 'start', source: 'auto' });
  await new Promise((r) => setImmediate(r));
  c.handle({ type: 'stop' });
  release({ ok: true, voices: ['a'] });
  await starting;
  assert.ok(c.session === null, 'no session'); // not assert.equal: inspecting a session walks the DOM
  assert.equal(ofType(t.chrome.sent, 'play').length, 0);
  assert.equal(barHosts(t.document), 0);
});

test('voices are asked once per session', async () => {
  let calls = 0;
  const listVoices = async () => {
    calls++;
    return { ok: true, voices: ['first'] };
  };
  const { c, bars } = await started({ listVoices });
  await c.handle({ type: 'start', source: 'auto' });
  assert.equal(calls, 1);
  bars[0].action('close');
  await c.handle({ type: 'start', source: 'auto' });
  assert.equal(calls, 2, 'a new session asks again');
});

test('default listVoices asks the service worker', async () => {
  const t = setup();
  const send = t.chrome.runtime.sendMessage;
  t.chrome.runtime.sendMessage = async (msg) => {
    await send(msg);
    return msg.type === 'list-voices' ? { ok: true, voices: ['sw-voice'] } : undefined;
  };
  const { listVoices, ...deps } = t.deps;
  const c = createController({ ...deps, doc: t.document, win: t.win, chrome: t.chrome });
  await c.handle({ type: 'start', source: 'auto' });
  assert.equal(ofType(t.chrome.sent, 'list-voices').length, 1);
  assert.equal(ofType(t.chrome.sent, 'play')[0].voice, 'sw-voice');
});

test('retry after nothing to read picks sentences again', async () => {
  const t = setup({ page: '<main id="m"></main>' });
  const c = install(t.win, t.deps);
  await c.handle({ type: 'start', source: 'auto' });
  assert.equal(c.session.state, 'error');
  assert.equal(ofType(t.chrome.sent, 'play').length, 0);
  // The page finished rendering its article meanwhile.
  t.document.getElementById('m').innerHTML = `<article>${[1, 2, 3, 4].map(longParagraph).join('')}</article>`;
  await t.bars[0].action('retry');
  const [play] = ofType(t.chrome.sent, 'play');
  assert.ok(play, 'play sent');
  assert.ok(play.sentences.length > 0);
});

test('a new start with nothing to read stops the running audio', async () => {
  const t = await started();
  assert.equal(ofType(t.chrome.sent, 'play').length, 1);
  assert.equal(ofType(t.chrome.sent, 'stop').length, 0);
  // The page now has nothing readable; a fresh start must not leave the old audio playing.
  t.document.body.innerHTML = '<main></main>';
  await t.c.handle({ type: 'start', source: 'auto' });
  assert.equal(t.c.session.state, 'error');
  assert.equal(ofType(t.chrome.sent, 'stop').length, 1);
  assert.equal(ofType(t.chrome.sent, 'play').length, 1);
});

test('an older start finishing after a newer one has no side effects', async () => {
  const t = await started();
  t.chrome.sent.length = 0;
  // The first settings load is slow, so the older start resumes after the newer one played.
  let release;
  const get = t.chrome.storage.sync.get;
  let calls = 0;
  t.chrome.storage.sync.get = async (defaults) => {
    if (calls++ === 0) await new Promise((r) => (release = r));
    return get(defaults);
  };
  // Older start: "Read selection" with nothing selected finds no sentences.
  const older = t.c.handle({ type: 'start', source: 'selection' });
  await new Promise((r) => setImmediate(r));
  await t.c.handle({ type: 'start', source: 'auto' });
  assert.equal(ofType(t.chrome.sent, 'play').length, 1);
  const statesBefore = t.bars[0].states.length;
  release();
  await older;
  assert.equal(ofType(t.chrome.sent, 'stop').length, 0, 'no stop for the newer playback');
  assert.equal(t.bars[0].states.length, statesBefore, 'bar untouched');
  assert.equal(t.c.session.state, 'loading');
});

test('autoscroll setting is read at start and passed to the highlighter', async () => {
  const on = await started();
  on.c.handle({ type: 'sentence-start', index: 1 });
  assert.equal(on.highlighter.opts.scroll, true);

  const off = await started({ stored: { autoscroll: false } });
  off.c.handle({ type: 'sentence-start', index: 1 });
  assert.equal(off.highlighter.shown, off.c.session.sentences[1], 'still highlighted');
  assert.equal(off.highlighter.opts.scroll, false);
});

test('autoscroll toggle on the bar saves the setting and stops scrolling', async () => {
  const { chrome, bars, highlighter, c } = await started();
  c.handle({ type: 'sentence-start', index: 1 });
  bars[0].action('autoscroll', false);
  await new Promise((r) => setImmediate(r));
  assert.equal(chrome.stored.autoscroll, false);
  c.handle({ type: 'sentence-start', index: 2 });
  assert.equal(highlighter.opts.scroll, false);
  // Turning it back on brings the current sentence into view right away.
  bars[0].action('autoscroll', true);
  await new Promise((r) => setImmediate(r));
  assert.equal(chrome.stored.autoscroll, true);
  assert.equal(highlighter.shown, c.session.sentences[2]);
  assert.equal(highlighter.opts.scroll, true);
  assert.equal(ofType(chrome.sent, 'autoscroll').length, 0, 'nothing sent to the engine');
});
