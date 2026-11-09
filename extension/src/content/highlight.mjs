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

  const SCROLLING = new Set(['auto', 'scroll']);

  // Ancestors that scroll their own content (overflow auto/scroll), innermost first.
  function scrollers(el) {
    const out = [];
    for (let node = el?.parentElement; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
      const style = win.getComputedStyle?.(node);
      if (style && (SCROLLING.has(style.overflowY) || SCROLLING.has(style.overflowX))) out.push(node);
    }
    return out;
  }

  // The box's scrollport (its padding box, without scrollbars) in viewport coordinates.
  function clientRect(box) {
    const r = box.getBoundingClientRect();
    const top = r.top + (box.clientTop || 0);
    const left = r.left + (box.clientLeft || 0);
    return { top, bottom: top + (box.clientHeight || r.height), left, right: left + (box.clientWidth || r.width) };
  }

  // What the user can actually see: the window viewport clipped by every scrolling ancestor.
  function visibleRect(boxes) {
    const v = { top: 0, bottom: win.innerHeight, left: 0, right: win.innerWidth };
    for (const box of boxes) {
      const r = clientRect(box);
      v.top = Math.max(v.top, r.top);
      v.bottom = Math.min(v.bottom, r.bottom);
      v.left = Math.max(v.left, r.left);
      v.right = Math.min(v.right, r.right);
    }
    return v;
  }

  // Off-screen = no part of the sentence lies in the visible rect (an empty rect hides everything).
  function isOffScreen(rect, visible) {
    return (
      visible.bottom <= visible.top ||
      visible.right <= visible.left ||
      rect.bottom <= visible.top ||
      rect.top >= visible.bottom ||
      rect.right <= visible.left ||
      rect.left >= visible.right
    );
  }

  function scrollTarget(range) {
    const node = range.startContainer;
    return node && node.nodeType === 1 ? node : node?.parentElement ?? node?.parentNode ?? null;
  }

  // Centre the sentence's block with scrollIntoView, which scrolls every scrolling ancestor and
  // the window. But when the block is taller than a scrollport it sits in, centring the block can
  // leave the sentence itself hidden, so scroll each level by the sentence's own offset instead:
  // every vertically overflowing ancestor from the innermost outwards, then the window, each
  // centring the sentence within it unless it is already fully visible there.
  // The offsets are computed up front from one set of measurements: scrolling a box moves the
  // sentence by the scrolled amount but never moves the box's ancestors, so the sentence's next
  // position is plain arithmetic. That keeps every step smooth (no re-measuring a rect that a
  // running smooth scroll has not updated yet), at the cost of trusting that each scrollBy is
  // applied in full (a box clamped at its scroll end leaves the sentence slightly off-centre).
  function scrollToSentence(range, rect, boxes) {
    const target = scrollTarget(range);
    const block = target?.getBoundingClientRect?.();
    const levels = boxes
      .filter((box) => box.scrollHeight > box.clientHeight && box.scrollBy)
      .map((box) => {
        const r = clientRect(box);
        return { top: r.top, bottom: r.bottom, scrollBy: (opts) => box.scrollBy(opts) };
      });
    if (win.scrollBy) levels.push({ top: 0, bottom: win.innerHeight, scrollBy: (opts) => win.scrollBy(opts) });
    const smallest = Math.min(win.innerHeight, ...levels.map((l) => l.bottom - l.top));
    if (block && block.height > smallest && levels.length) {
      let top = rect.top;
      let bottom = rect.bottom;
      for (const level of levels) {
        if (top >= level.top && bottom <= level.bottom) continue;
        const delta = Math.round((top + bottom) / 2 - (level.top + level.bottom) / 2);
        level.scrollBy({ top: delta, behavior: 'smooth' });
        top -= delta;
        bottom -= delta;
      }
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
    const boxes = scrollers(scrollTarget(sentence.range));
    if (isOffScreen(rect, visibleRect(boxes))) scrollToSentence(sentence.range, rect, boxes);
  }

  function clear() {
    current?.clear();
    highlights.delete(NAME);
  }

  return { show, clear };
}
