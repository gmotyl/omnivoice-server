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

  function show(sentence) {
    ensureStyle();
    if (!current) current = new Highlight();
    current.clear();
    current.add(sentence.range);
    highlights.set(NAME, current);
    const rect = sentence.range.getBoundingClientRect();
    if (isOffScreen(rect)) {
      scrollTarget(sentence.range)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    }
  }

  function clear() {
    current?.clear();
    highlights.delete(NAME);
  }

  return { show, clear };
}
