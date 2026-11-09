// Segmentation: container → paragraphs → sentences, read in place.
// Sentence: {text, pieces: string[], range: Range, paragraph: number}
//
// A "paragraph" is a contiguous run of text owned by one block element. Text of a
// nested block belongs to that nested block only, so `li > p` is counted once and
// `<li>lead <blockquote>…</blockquote> tail</li>` yields three runs in document order.

const BLOCK_TAGS = new Set([
  'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'TD', 'TH', 'CAPTION', 'DD', 'FIGCAPTION',
]);
export const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, caption, dd, figcaption';
// Generic block containers: not paragraphs themselves, but their direct text (outside any
// listed block) forms its own run, and they always break a run, e.g. `<div>Bare text.</div>`.
const CONTAINER_TAGS = new Set([
  'BODY', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'FIGURE',
  'ADDRESS', 'DETAILS', 'SUMMARY', 'DT', 'FORM', 'FIELDSET', 'CENTER',
  'UL', 'OL', 'DL', 'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR',
]);
// Never read: non-content elements and form controls (their labels and option lists are UI).
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
  'BUTTON', 'SELECT', 'OPTION', 'OPTGROUP', 'TEXTAREA', 'LABEL', 'INPUT',
]);
const SKIP_SELECTOR =
  'script, style, noscript, template, button, select, option, optgroup, textarea, label, input, [aria-hidden="true"]';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// Lower-case abbreviations (without the final dot) after which a sentence never ends,
// keyed by primary language subtag. Ones that often end a sentence ("itd.", "etc.", units
// like "s.", "ms.", "min.", "mln.", "r.") are deliberately left out.
const COMMON_ABBREVIATIONS = ['dr', 'prof', 'tel', 'vs'];
const ABBREVIATIONS = {
  pl: new Set([...COMMON_ABBREVIATIONS,
    'ok', 'np', 'tzn', 'tj', 'tzw', 'm.in', 'wg', 'nr', 'ul', 'mgr', 'inż', 'hab', 'gen',
    'płk', 'ks', 'św', 'ds', 'zob', 'por', 'ang', 'łac', 'ww', 'jw']),
  en: new Set([...COMMON_ABBREVIATIONS,
    'mr', 'mrs', 'st', 'e.g', 'i.e', 'jr', 'sr', 'fig', 'approx', 'cf', 'dept']),
};
const FALLBACK_ABBREVIATIONS = new Set(COMMON_ABBREVIATIONS);

function abbreviationsFor(lang) {
  const primary = String(lang || '').toLowerCase().split(/[-_]/)[0];
  return ABBREVIATIONS[primary] || FALLBACK_ABBREVIATIONS;
}

// Captures the token before the final dot and the word before that token (if any).
const TRAILING_ABBREVIATION = /(?:^|[\s(„"'«])(?:(\S+)\s+)?((?:\p{L}+\.)*\p{L}+)\.$/u;

function isSkipped(el) {
  return SKIP_TAGS.has(el.tagName) || el.getAttribute('aria-hidden') === 'true';
}

// Collect text runs: [{block, nodes: [{node, start, end}], text}].
// `nodes` may leave gaps in `text`: a <br> adds a virtual "\n" owned by no text node.
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
        if (!current) current = { block, nodes: [], text: '' };
        const start = current.text.length;
        current.text += child.data;
        current.nodes.push({ node: child, start, end: current.text.length });
      } else if (child.nodeType === ELEMENT_NODE) {
        if (isSkipped(child)) continue;
        if (child.tagName === 'BR') {
          // a line break separates words (it is whitespace to the segmenter); trimming keeps it out of ranges
          if (current) current.text += '\n';
        } else if (BLOCK_TAGS.has(child.tagName)) {
          flush();
          walk(child, child);
          flush();
        } else if (CONTAINER_TAGS.has(child.tagName)) {
          // a container breaks the run, so its direct text is a run of its own
          flush();
          walk(child, block);
          flush();
        } else {
          walk(child, block);
        }
      }
    }
  };

  // text is always read: a root outside any listed block owns its direct text (e.g. <body>)
  walk(root, root.closest(BLOCK_SELECTOR) || root);
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

function endsWithAbbreviation(segmentText, abbreviations) {
  const match = TRAILING_ABBREVIATION.exec(segmentText.trimEnd());
  if (!match) return false;
  const [, before, word] = match;
  if (abbreviations.has(word.toLowerCase())) return true;
  // A single capital is an initial ("J. Kowalski", "z J. Kowalskim", "J. R. Tolkien") when it
  // starts the sentence or follows a lowercase word or another initial. After a capitalised
  // word it ends the sentence ("Plan B. Next."), so "John F. Kennedy" splits there too.
  if (!/^\p{Lu}$/u.test(word) || word === 'I') return false;
  return !before || /^\p{Ll}/u.test(before) || /^\p{Lu}\.$/u.test(before);
}

// Sentence spans [start, end) over `text`, abbreviation-guarded.
function sentenceSpans(text, segmenter, abbreviations) {
  const spans = [];
  let open = null;
  for (const { segment, index } of segmenter.segment(text)) {
    if (open) open.end = index + segment.length;
    else open = { start: index, end: index + segment.length };
    if (!endsWithAbbreviation(text.slice(open.start, open.end), abbreviations)) {
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
  const abbreviations = abbreviationsFor(lang);
  const sentences = [];
  let paragraph = 0;

  for (const run of collectRuns(root)) {
    // HTML whitespace is not a sentence separator outside <pre>; replace it 1:1 so offsets hold.
    const source = run.block.tagName === 'PRE' ? run.text : run.text.replace(/\s/g, ' ');
    let produced = false;

    for (const span of sentenceSpans(source, segmenter, abbreviations)) {
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

// Cut a sentence into pieces of at most `max` UTF-16 units, at the last space that fits.
// Join behaviour: a cut at a space drops that space (rejoin with " "); a word longer than
// `max` is hard-cut with nothing dropped (rejoin with ""), never inside a surrogate pair.
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
      let cut = max;
      if (cut > 1 && /[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
  }
  if (rest.length) pieces.push(rest);
  return pieces;
}
