// Reading sources: the article container (Readability, read in place), the <body>
// fallback, and the current selection. All ranges point into the live DOM.

import { Readability } from '@mozilla/readability';
import { segment, cutPieces, BLOCK_SELECTOR } from './segment.mjs';

const MARK = 'data-omnivoice-id';
const CHROME_SELECTOR = 'nav, header, footer, aside, [aria-hidden="true"]';
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function commonAncestor(elements) {
  let lca = elements[0];
  for (const el of elements) {
    while (lca && !lca.contains(el)) lca = lca.parentElement;
  }
  return lca;
}

// Pair every text node of the clone with its live twin (the trees are identical right after
// cloneNode). Readability mostly moves nodes, so a text node it keeps still maps back.
function pairTextNodes(cloneRoot, liveRoot) {
  const pairs = new Map();
  const stack = [[cloneRoot, liveRoot]];
  while (stack.length) {
    const [c, l] = stack.pop();
    const cc = c.childNodes;
    const lc = l.childNodes;
    for (let i = 0; i < cc.length && i < lc.length; i++) {
      if (cc[i].nodeType === TEXT_NODE) pairs.set(cc[i], lc[i]);
      else if (cc[i].nodeType === ELEMENT_NODE) stack.push([cc[i], lc[i]]);
    }
  }
  return pairs;
}

// Readability runs on a clone. Each text node it keeps is mapped back to the live DOM: by
// identity when it was moved, else (new <p> wrappers, the innerHTML retry path) through the
// index mark of its nearest marked ancestor. The deepest common ancestor is the container.
export function articleContainer(doc, { Readability: Reader = Readability } = {}) {
  const body = doc.body;
  const live = [...body.querySelectorAll('*')];
  const clone = doc.cloneNode(true);
  const cloned = [...clone.body.querySelectorAll('*')];
  if (cloned.length !== live.length) return body;
  cloned.forEach((el, i) => el.setAttribute(MARK, String(i)));
  const pairs = pairTextNodes(clone.body, body);

  let article = null;
  try {
    // serializer: keep the result as an element of the clone instead of an HTML string
    article = new Reader(clone, { serializer: (el) => el }).parse();
  } catch {
    article = null;
  }
  const content = article && article.content;
  if (!content || typeof content.querySelectorAll !== 'function') return body;

  const toLive = (el) => live[Number(el.getAttribute(MARK))];
  const textHolders = [];
  for (const text of textNodesUnder(content)) {
    if (!/\S/.test(text.data)) continue;
    const twin = pairs.get(text);
    if (twin && twin.parentElement && body.contains(twin)) {
      textHolders.push(twin.parentElement);
      continue;
    }
    const marked = text.parentElement && text.parentElement.closest(`[${MARK}]`);
    const holder = marked && content.contains(marked) ? toLive(marked) : null;
    if (holder) textHolders.push(holder);
  }
  // Text in page chrome (a kept sidebar, a footer) must not widen the container: the
  // ancestor is computed from article text alone when there is any.
  const articleText = textHolders.filter((el) => !el.closest(CHROME_SELECTOR));
  const candidates = articleText.length
    ? articleText
    : textHolders.length
      ? textHolders
      : [...content.querySelectorAll(`[${MARK}]`)].map(toLive).filter(Boolean);
  if (!candidates.length) return body;

  const container = commonAncestor(candidates);
  return container && body.contains(container) ? container : body;
}

// Paragraph indexes stay contiguous from 0 after sentences were dropped.
function renumber(sentences) {
  const map = new Map();
  return sentences.map((s) => {
    if (!map.has(s.paragraph)) map.set(s.paragraph, map.size);
    return { ...s, paragraph: map.get(s.paragraph) };
  });
}

// True when the node sits in a chrome element strictly inside the container. Chrome that
// holds the container itself (an article inside an <aside>) does not count.
function inChromeWithin(node, container) {
  let el = node.nodeType === ELEMENT_NODE ? node : node.parentElement;
  for (; el && el !== container; el = el.parentElement) {
    if (el.matches(CHROME_SELECTOR)) return true;
  }
  return false;
}

export function articleSentences(doc, lang, options = {}) {
  lang = lang || doc.documentElement.getAttribute('lang') || undefined;
  const container = articleContainer(doc, options);
  const sentences = segment(container, { lang, doc });
  // Page chrome inside the container is not read: the <body> fallback, or a wrapper such as
  // div#page when Readability keeps a short sibling next to the article.
  const kept = sentences.filter((s) => !inChromeWithin(s.range.startContainer, container));
  return kept.length === sentences.length ? sentences : renumber(kept);
}

function indexOf(node) {
  return Array.prototype.indexOf.call(node.parentNode.childNodes, node);
}

function ancestry(node) {
  const chain = [];
  for (let n = node; n; n = n.parentNode) chain.unshift(n);
  return chain;
}

// Tree order of two nodes: -1 if a precedes b (an ancestor precedes its descendants), 1 if
// it follows. Computed by hand: linkedom's compareDocumentPosition is wrong between text nodes.
function treeOrder(a, b) {
  const pa = ancestry(a);
  const pb = ancestry(b);
  let i = 0;
  while (i < pa.length && i < pb.length && pa[i] === pb[i]) i++;
  if (i === pa.length) return -1;
  if (i === pb.length) return 1;
  return indexOf(pa[i]) < indexOf(pb[i]) ? -1 : 1;
}

// Compare two boundary points (DOM spec "position of a boundary point"): -1, 0 or 1.
function compare(a, offsetA, b, offsetB) {
  if (a === b) return Math.sign(offsetA - offsetB);
  if (treeOrder(a, b) > 0) return -compare(b, offsetB, a, offsetA);
  if (a.contains(b)) {
    let child = b;
    while (child.parentNode !== a) child = child.parentNode;
    if (indexOf(child) < offsetA) return 1;
  }
  return -1;
}

function textNodesUnder(node, out = []) {
  for (const child of node.childNodes) {
    if (child.nodeType === TEXT_NODE) out.push(child);
    else textNodesUnder(child, out);
  }
  return out;
}

// Normalise a selection boundary to a text-node point.
function textPoint(doc, node, offset, isEnd) {
  if (node.nodeType === TEXT_NODE) return { node, offset };
  const texts = textNodesUnder(doc.documentElement);
  if (isEnd) {
    for (let i = texts.length - 1; i >= 0; i--) {
      if (compare(texts[i], 0, node, offset) < 0) return { node: texts[i], offset: texts[i].data.length };
    }
  } else {
    for (const t of texts) {
      if (compare(t, t.data.length, node, offset) > 0) return { node: t, offset: 0 };
    }
  }
  return null;
}

export function selectionSentences(doc, selection, lang) {
  if (!selection || !selection.rangeCount || selection.isCollapsed) return [];
  const range = selection.getRangeAt(0);
  const start = textPoint(doc, range.startContainer, range.startOffset, false);
  const end = textPoint(doc, range.endContainer, range.endOffset, true);
  if (!start || !end || compare(start.node, start.offset, end.node, end.offset) >= 0) return [];

  let root = range.commonAncestorContainer;
  if (root.nodeType !== ELEMENT_NODE) root = root.parentElement;
  if (!root) return [];
  root = root.closest(BLOCK_SELECTOR) || root;
  lang = lang || doc.documentElement.getAttribute('lang') || undefined;

  const out = [];
  for (const s of segment(root, { lang, doc })) {
    const r = s.range;
    // keep sentences that overlap the selection
    if (compare(r.endContainer, r.endOffset, start.node, start.offset) <= 0) continue;
    if (compare(r.startContainer, r.startOffset, end.node, end.offset) >= 0) continue;

    const clipStart = compare(start.node, start.offset, r.startContainer, r.startOffset) > 0;
    const clipEnd = compare(end.node, end.offset, r.endContainer, r.endOffset) < 0;
    if (!clipStart && !clipEnd) {
      out.push(s);
      continue;
    }
    const clipped = doc.createRange();
    if (clipStart) clipped.setStart(start.node, start.offset);
    else clipped.setStart(r.startContainer, r.startOffset);
    if (clipEnd) clipped.setEnd(end.node, end.offset);
    else clipped.setEnd(r.endContainer, r.endOffset);
    const text = clipped.toString().replace(/\s+/g, ' ').trim();
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    out.push({ text, pieces: cutPieces(text), range: clipped, paragraph: s.paragraph });
  }
  return renumber(out);
}

function paragraphStart(sentences, i) {
  const { paragraph } = sentences[i];
  while (i > 0 && sentences[i - 1].paragraph === paragraph) i--;
  return i;
}

function insideRange(node, r) {
  if (node === r.startContainer || node === r.endContainer) return true;
  return compare(node, 0, r.startContainer, r.startOffset) >= 0 && compare(node, 0, r.endContainer, r.endOffset) < 0;
}

export function sentenceIndexAt(sentences, node) {
  if (!node || !sentences.length) return -1;
  for (let i = 0; i < sentences.length; i++) {
    if (insideRange(node, sentences[i].range)) return paragraphStart(sentences, i);
  }
  // e.g. a click on the paragraph element itself or on whitespace between sentences
  const el = node.nodeType === ELEMENT_NODE ? node : node.parentElement;
  const block = el && el.closest(BLOCK_SELECTOR);
  if (!block) return -1;
  const i = sentences.findIndex((s) => block.contains(s.range.startContainer));
  return i < 0 ? -1 : paragraphStart(sentences, i);
}
