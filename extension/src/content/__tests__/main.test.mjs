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
    storage: { sync: { get: async (defaults) => ({ ...defaults, ...stored }) } },
  };
}

function setup({ selection = null, stored = {}, listVoices = null } = {}) {
  const { document, window } = parseHTML(
    `<!doctype html><html lang="en"><head><title>Test</title></head><body>${PAGE}</body></html>`,
  );
  installTextRange(document);
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
    show(s) {
      this.shown = s;
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
  return { document, window, win, chrome, highlighter, highlights, bars, deps };
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
  const t = setup();
  t.document.elementFromPoint = (x, y) => (x === 10 && y === 20 ? t.document.getElementById('p4') : null);
  const c = install(t.win, t.deps);
  await c.handle({ type: 'start', source: 'from-here', x: 10, y: 20 });
  const [play] = ofType(t.chrome.sent, 'play');
  assert.match(play.sentences[play.start][0], /^Paragraph 4 talks/);

  // nothing under the point → falls back to the first sentence
  const t2 = setup();
  t2.document.elementFromPoint = () => null;
  const c2 = install(t2.win, t2.deps);
  await c2.handle({ type: 'start', source: 'from-here', x: 1, y: 1 });
  assert.equal(ofType(t2.chrome.sent, 'play')[0].start, 0);
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
    const { chrome, document, highlighter, bars, c } = await started();
    c.handle({ type: 'sentence-start', index: 1 });
    if (how === 'message') c.handle({ type: 'stop' });
    else bars[0].action('close');
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
