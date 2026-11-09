// Reading sources: the article container (Readability, read in place), the <body>
// fallback, and the current selection. All ranges point into the live DOM.

import { Readability } from '@mozilla/readability';
import { segment, cutPieces, BLOCK_SELECTOR } from './segment.mjs';

const MARK = 'data-omnivoice-id';
const CHROME_SELECTOR = 'nav, header, footer, aside';
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function hasOwnText(el) {
  for (const child of el.childNodes) {
    if (child.nodeType === TEXT_NODE && /\S/.test(child.data)) return true;
  }
  return false;
}

function commonAncestor(elements) {
  let lca = elements[0];
  for (const el of elements) {
    while (lca && !lca.contains(el)) lca = lca.parentElement;
  }
  return lca;
}

// Readability runs on a clone whose body elements carry their index; the elements it
// keeps are mapped back to the live DOM and their deepest common ancestor is the container.
export function articleContainer(doc, { Readability: Reader = Readability } = {}) {
  const body = doc.body;
  const live = [...body.querySelectorAll('*')];
  const clone = doc.cloneNode(true);
  const cloned = [...clone.body.querySelectorAll('*')];
  if (cloned.length !== live.length) return body;
  cloned.forEach((el, i) => el.setAttribute(MARK, String(i)));

  let article = null;
  try {
    // serializer: keep the result as an element of the clone instead of an HTML string
    article = new Reader(clone, { serializer: (el) => el }).parse();
  } catch {
    article = null;
  }
  const content = article && article.content;
  if (!content || typeof content.querySelectorAll !== 'function') return body;

  const kept = [...content.querySelectorAll(`[${MARK}]`)];
  const toLive = (el) => live[Number(el.getAttribute(MARK))];
  const textHolders = kept.filter(hasOwnText).map(toLive).filter(Boolean);
  const candidates = textHolders.length ? textHolders : kept.map(toLive).filter(Boolean);
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

function inChrome(node) {
  const el = node.nodeType === ELEMENT_NODE ? node : node.parentElement;
  return Boolean(el && el.closest(CHROME_SELECTOR));
}

export function articleSentences(doc, lang, options = {}) {
  lang = lang || doc.documentElement.getAttribute('lang') || undefined;
  const container = articleContainer(doc, options);
  const sentences = segment(container, { lang, doc });
  if (container !== doc.body) return sentences;
  // body fallback: page chrome is not read (aria-hidden is already skipped by segment)
  return renumber(sentences.filter((s) => !inChrome(s.range.startContainer)));
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
