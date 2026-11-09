import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createHighlighter } from '../highlight.mjs';

// Fake of the CSS Custom Highlight API: Highlight is set-like, the registry map-like.
class FakeHighlight extends Set {
  constructor(...ranges) { super(ranges); }
}

function setup({ rect = { top: 100, bottom: 120, left: 10, right: 200 } } = {}) {
  const { document, window } = parseHTML(`<!doctype html><html><head></head><body>
    <article id="root"><p id="p1">First sentence. Second sentence.</p><p id="p2">Third one.</p></article>
  </body></html>`);
  const win = { innerHeight: 800, innerWidth: 1200 };
  const scrolls = [];
  for (const p of document.querySelectorAll('p')) {
    p.scrollIntoView = (opts) => scrolls.push({ id: p.id, opts });
  }
  // A range stand-in: the highlighter only reads its start node and its rect.
  const makeSentence = (id, r = rect) => ({
    text: id,
    range: {
      startContainer: document.getElementById(id).firstChild,
      getBoundingClientRect: () => r,
    },
  });
  const highlights = new Map();
  const hl = createHighlighter({ highlights, Highlight: FakeHighlight, doc: document, win });
  return { document, window, win, scrolls, makeSentence, highlights, hl };
}

test('show puts only the current range in the highlight', () => {
  const { document, makeSentence, highlights, hl } = setup();
  const a = makeSentence('p1');
  const b = makeSentence('p2');
  hl.show(a);
  hl.show(b);
  const current = highlights.get('reader-current');
  assert.ok(current instanceof FakeHighlight);
  assert.deepEqual([...current], [b.range]);
  const styles = [...document.querySelectorAll('style')].filter((s) => s.textContent.includes('::highlight(reader-current)'));
  assert.equal(styles.length, 1);
  hl.clear();
  assert.equal(highlights.has('reader-current'), false);
});

test('scrolls only when the sentence is off-screen', () => {
  const { scrolls, makeSentence, hl } = setup();
  hl.show(makeSentence('p1', { top: 100, bottom: 120, left: 0, right: 100 }));
  assert.equal(scrolls.length, 0);
  hl.show(makeSentence('p2', { top: 1500, bottom: 1520, left: 0, right: 100 }));
  hl.show(makeSentence('p1', { top: -300, bottom: -280, left: 0, right: 100 }));
  assert.deepEqual(scrolls, [
    { id: 'p2', opts: { block: 'center', behavior: 'smooth' } },
    { id: 'p1', opts: { block: 'center', behavior: 'smooth' } },
  ]);
});

test('highlighting leaves the container DOM unchanged', () => {
  const { document, makeSentence, hl } = setup();
  const root = document.getElementById('root');
  const before = root.innerHTML;
  hl.show(makeSentence('p1'));
  hl.show(makeSentence('p2', { top: 2000, bottom: 2020, left: 0, right: 10 }));
  hl.clear();
  assert.equal(root.innerHTML, before);
});

test('tall paragraph scrolls the window to the sentence', () => {
  const { document, win, scrolls, makeSentence, hl } = setup();
  const winScrolls = [];
  win.scrollBy = (opts) => winScrolls.push(opts);
  // p1 is taller than the 800px viewport: centring the paragraph could leave the sentence off-screen.
  document.getElementById('p1').getBoundingClientRect = () => ({ top: -500, bottom: 2500, height: 3000, left: 0, right: 100 });
  hl.show(makeSentence('p1', { top: 1900, bottom: 1920, left: 0, right: 100 }));
  assert.equal(scrolls.length, 0);
  // Sentence centre (1910) moves to the viewport centre (400).
  assert.deepEqual(winScrolls, [{ top: 1510, behavior: 'smooth' }]);
  // An on-screen sentence in the same tall paragraph does not scroll.
  hl.show(makeSentence('p1', { top: 300, bottom: 320, left: 0, right: 100 }));
  assert.equal(winScrolls.length, 1);
});

test('tall paragraph in a scroll container scrolls the container to the sentence', () => {
  const { document, win, scrolls, makeSentence, hl } = setup();
  const winScrolls = [];
  win.scrollBy = (opts) => winScrolls.push(opts);
  const root = document.getElementById('root');
  // #root is a 600px-high scroll box 200px down the page; the page itself does not scroll.
  win.getComputedStyle = (el) => ({ overflowY: el === root ? 'auto' : 'visible' });
  Object.defineProperty(root, 'scrollHeight', { value: 5000 });
  Object.defineProperty(root, 'clientHeight', { value: 600 });
  root.getBoundingClientRect = () => ({ top: 200, bottom: 800, height: 600, left: 0, right: 100 });
  const boxScrolls = [];
  root.scrollBy = (opts) => boxScrolls.push(opts);
  document.getElementById('p1').getBoundingClientRect = () => ({ top: -500, bottom: 2500, height: 3000, left: 0, right: 100 });
  hl.show(makeSentence('p1', { top: 1900, bottom: 1920, left: 0, right: 100 }));
  assert.equal(scrolls.length, 0);
  assert.equal(winScrolls.length, 0);
  // Sentence centre (1910) moves to the container's centre (200 + 600 / 2 = 500).
  assert.deepEqual(boxScrolls, [{ top: 1410, behavior: 'smooth' }]);
});

// Makes `el` a vertical scroll box whose scrollport sits at viewport rows top..top+height.
function scrollBox(win, el, { top, height, scrollHeight = 5000 }) {
  const boxes = (win.boxes ??= new Set());
  boxes.add(el);
  win.getComputedStyle = (node) => ({ overflowY: boxes.has(node) ? 'auto' : 'visible', overflowX: 'visible' });
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { value: height });
  el.getBoundingClientRect = () => ({ top, bottom: top + height, height, left: 0, right: 1000 });
  const scrolls = [];
  el.scrollBy = (opts) => scrolls.push(opts);
  return scrolls;
}

test('a sentence clipped by its scroll box but inside the window scrolls into view', () => {
  const { document, win, scrolls, makeSentence, hl } = setup();
  // #root shows viewport rows 200..500; the sentence at 600 is inside the window but hidden by the box.
  scrollBox(win, document.getElementById('root'), { top: 200, height: 300 });
  document.getElementById('p2').getBoundingClientRect = () => ({ top: 590, bottom: 630, height: 40, left: 0, right: 100 });
  hl.show(makeSentence('p2', { top: 600, bottom: 620, left: 0, right: 100 }));
  assert.deepEqual(scrolls, [{ id: 'p2', opts: { block: 'center', behavior: 'smooth' } }]);
  // Inside the box's scrollport: no scroll.
  hl.show(makeSentence('p2', { top: 300, bottom: 320, left: 0, right: 100 }));
  assert.equal(scrolls.length, 1);
});

test('a tall paragraph in a scroll box below the window is revealed through the window', () => {
  const { document, win, scrolls, makeSentence, hl } = setup();
  const winScrolls = [];
  win.scrollBy = (opts) => winScrolls.push(opts);
  // #root's scrollport (rows 1200..1800) is itself below the 800px window.
  const boxScrolls = scrollBox(win, document.getElementById('root'), { top: 1200, height: 600 });
  document.getElementById('p1').getBoundingClientRect = () => ({ top: -500, bottom: 2500, height: 3000, left: 0, right: 100 });
  hl.show(makeSentence('p1', { top: 1900, bottom: 1920, left: 0, right: 100 }));
  assert.equal(scrolls.length, 0);
  // Box: sentence centre 1910 -> box centre 1500. Window: 1500 -> window centre 400.
  assert.deepEqual(boxScrolls, [{ top: 410, behavior: 'smooth' }]);
  assert.deepEqual(winScrolls, [{ top: 1100, behavior: 'smooth' }]);
});

test('a tall paragraph in a nested scroll box is revealed through the outer scroll box', () => {
  const { document, win, scrolls, makeSentence, hl } = setup();
  const winScrolls = [];
  win.scrollBy = (opts) => winScrolls.push(opts);
  const root = document.getElementById('root');
  const outer = document.createElement('div');
  root.parentNode.insertBefore(outer, root);
  outer.appendChild(root);
  // The outer box fills the window (rows 0..800); the inner box sits below its visible part.
  const outerScrolls = scrollBox(win, outer, { top: 0, height: 800 });
  const innerScrolls = scrollBox(win, root, { top: 1200, height: 600 });
  document.getElementById('p1').getBoundingClientRect = () => ({ top: -500, bottom: 2500, height: 3000, left: 0, right: 100 });
  hl.show(makeSentence('p1', { top: 1900, bottom: 1920, left: 0, right: 100 }));
  assert.equal(scrolls.length, 0);
  assert.deepEqual(innerScrolls, [{ top: 410, behavior: 'smooth' }]);
  assert.deepEqual(outerScrolls, [{ top: 1100, behavior: 'smooth' }]);
  // The sentence is then centred in the outer box, which the window already shows.
  assert.equal(winScrolls.length, 0);
});
