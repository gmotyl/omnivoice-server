// Highlights the current sentence with the CSS Custom Highlight API, so the page DOM is
// never mutated, and scrolls it into view only when it is off-screen.

const NAME = 'reader-current';
const STYLE_ID = 'omnivoice-reader-highlight-style';
const STYLE = `::highlight(${NAME}) { background-color: rgba(255, 213, 0, 0.45); color: inherit; }`;

// Defaults are read from globalThis at call time (not import time), so the module loads in
// Node where CSS, Highlight, document and window do not exist.
export function createHighlighter({
  highlights = globalThis.CSS?.highlights,
  Highlight = globalThis.Highlight,
  doc = globalThis.document,
  win = globalThis.window,
} = {}) {
  let current = null;

  function ensureStyle() {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = STYLE;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function isOffScreen(rect) {
    const h = win.innerHeight;
    const w = win.innerWidth;
    return rect.bottom <= 0 || rect.top >= h || rect.right <= 0 || rect.left >= w;
  }

  function scrollTarget(range) {
    const node = range.startContainer;
    return node && node.nodeType === 1 ? node : node?.parentElement ?? node?.parentNode ?? null;
  }

  // Centre the sentence's block; but when that block is taller than the viewport, centring
  // it can leave the sentence off-screen, so scroll the window by the sentence's own offset.
  // (Measured up front: after a smooth scrollIntoView the rect is not updated yet.)
  function scrollToSentence(range, rect) {
    const target = scrollTarget(range);
    const block = target?.getBoundingClientRect?.();
    if (block && block.height > win.innerHeight && win.scrollBy) {
      const top = Math.round((rect.top + rect.bottom) / 2 - win.innerHeight / 2);
      win.scrollBy({ top, behavior: 'smooth' });
      return;
    }
    target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }

  function show(sentence) {
    ensureStyle();
    if (!current) current = new Highlight();
    current.clear();
    current.add(sentence.range);
    highlights.set(NAME, current);
    const rect = sentence.range.getBoundingClientRect();
    if (isOffScreen(rect)) scrollToSentence(sentence.range, rect);
  }

  function clear() {
    current?.clear();
    highlights.delete(NAME);
  }

  return { show, clear };
}
