// Segmentation: container → paragraphs → sentences, read in place.
// Sentence: {text, pieces: string[], range: Range, paragraph: number}
//
// A "paragraph" is a contiguous run of text owned by one block element. Text of a
// nested block belongs to that nested block only, so `li > p` is counted once and
// `<li>lead <blockquote>…</blockquote> tail</li>` yields three runs in document order.

const BLOCK_TAGS = new Set([
  'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'TD', 'DD', 'FIGCAPTION',
]);
export const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, dd, figcaption';
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
const SKIP_SELECTOR = 'script, style, noscript, template, [aria-hidden="true"]';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// Lower-case abbreviations (without the final dot) after which a sentence never ends.
// Ones that often end a sentence ("itd.", "etc.", units like "s.", "min.", "mln.", "r.")
// are deliberately left out.
const ABBREVIATIONS = new Set([
  // Polish
  'ok', 'np', 'tzn', 'tj', 'tzw', 'm.in', 'wg', 'nr', 'ul', 'dr', 'prof', 'mgr', 'inż',
  'hab', 'gen', 'płk', 'ks', 'św', 'ds', 'zob', 'por', 'ang', 'łac', 'ww', 'jw', 'tel',
  // English
  'mr', 'mrs', 'ms', 'st', 'vs', 'e.g', 'i.e', 'jr', 'sr', 'fig', 'approx', 'cf', 'dept',
]);

const TRAILING_ABBREVIATION = /(?:^|[\s(„"'«])((?:\p{L}+\.)*\p{L}+)\.$/u;

function isSkipped(el) {
  return SKIP_TAGS.has(el.tagName) || el.getAttribute('aria-hidden') === 'true';
}

// Collect text runs: [{block, nodes: [{node, start, end}], text}].
function collectRuns(root) {
  const runs = [];
  let current = null;

  const flush = () => {
    if (current && current.nodes.length) runs.push(current);
    current = null;
  };

  const walk = (node, block) => {
    for (const child of node.childNodes) {
      if (child.nodeType === TEXT_NODE) {
        if (!block) continue; // text outside any block element is not read
        if (!current) current = { block, nodes: [], text: '' };
        const start = current.text.length;
        current.text += child.data;
        current.nodes.push({ node: child, start, end: current.text.length });
      } else if (child.nodeType === ELEMENT_NODE) {
        if (isSkipped(child)) continue;
        if (BLOCK_TAGS.has(child.tagName)) {
          flush();
          walk(child, child);
          flush();
        } else {
          walk(child, block);
        }
      }
    }
  };

  walk(root, root.closest(BLOCK_SELECTOR));
  flush();
  return runs;
}

function makeSegmenter(lang) {
  try {
    return new Intl.Segmenter(lang || undefined, { granularity: 'sentence' });
  } catch {
    return new Intl.Segmenter(undefined, { granularity: 'sentence' });
  }
}

function endsWithAbbreviation(segmentText) {
  const match = TRAILING_ABBREVIATION.exec(segmentText.trimEnd());
  if (!match) return false;
  const word = match[1];
  // single-letter initials ("J. Kowalski") never end a sentence either; English "I." may
  return ABBREVIATIONS.has(word.toLowerCase()) || (/^\p{Lu}$/u.test(word) && word !== 'I');
}

// Sentence spans [start, end) over `text`, abbreviation-guarded.
function sentenceSpans(text, segmenter) {
  const spans = [];
  let open = null;
  for (const { segment, index } of segmenter.segment(text)) {
    if (open) open.end = index + segment.length;
    else open = { start: index, end: index + segment.length };
    if (!endsWithAbbreviation(text.slice(open.start, open.end))) {
      spans.push(open);
      open = null;
    }
  }
  if (open) spans.push(open);
  return spans;
}

// Map a run offset to a text-node boundary. `atEnd` prefers the node that ends there.
function boundary(nodes, offset, atEnd) {
  for (const entry of nodes) {
    if (atEnd ? offset > entry.start && offset <= entry.end : offset >= entry.start && offset < entry.end) {
      return { node: entry.node, offset: offset - entry.start };
    }
  }
  const last = nodes[nodes.length - 1];
  return { node: last.node, offset: last.node.data.length };
}

export function segment(root, { lang, doc } = {}) {
  doc = doc || root.ownerDocument;
  if (!root || root.closest(SKIP_SELECTOR)) return [];

  const segmenter = makeSegmenter(lang);
  const sentences = [];
  let paragraph = 0;

  for (const run of collectRuns(root)) {
    // HTML whitespace is not a sentence separator outside <pre>; replace it 1:1 so offsets hold.
    const source = run.block.tagName === 'PRE' ? run.text : run.text.replace(/\s/g, ' ');
    let produced = false;

    for (const span of sentenceSpans(source, segmenter)) {
      let { start, end } = span;
      while (start < end && /\s/.test(source[start])) start++;
      while (end > start && /\s/.test(source[end - 1])) end--;
      const text = source.slice(start, end).replace(/\s+/g, ' ');
      if (!/[\p{L}\p{N}]/u.test(text)) continue;

      const from = boundary(run.nodes, start, false);
      const to = boundary(run.nodes, end, true);
      const range = doc.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);

      sentences.push({ text, pieces: cutPieces(text), range, paragraph });
      produced = true;
    }
    if (produced) paragraph++;
  }
  return sentences;
}

export function cutPieces(text, max = 400) {
  const pieces = [];
  let rest = text;
  while (rest.length > max) {
    const space = rest.lastIndexOf(' ', max);
    if (space > 0) {
      pieces.push(rest.slice(0, space));
      rest = rest.slice(space + 1);
    } else {
      // no space within the limit: hard cut so a request never exceeds `max`
      pieces.push(rest.slice(0, max));
      rest = rest.slice(max);
    }
  }
  if (rest.length) pieces.push(rest);
  return pieces;
}
