// Test-only Range for linkedom: linkedom 0.18 ships Range without setStart/setEnd
// (commented out as TODO) and without toString(). This minimal stand-in keeps the
// DOM boundary points exactly as set and serialises the text between them, which
// is all segment() relies on. Only text-node boundaries are supported.

const TEXT_NODE = 3;

function textNodesUnder(node, out = []) {
  for (const child of node.childNodes) {
    if (child.nodeType === TEXT_NODE) out.push(child);
    else textNodesUnder(child, out);
  }
  return out;
}

export class TextRange {
  constructor(doc) {
    this.doc = doc;
    this.startContainer = null;
    this.startOffset = 0;
    this.endContainer = null;
    this.endOffset = 0;
  }

  setStart(node, offset) {
    if (node.nodeType !== TEXT_NODE) throw new Error('TextRange: start must be a text node');
    if (offset < 0 || offset > node.data.length) throw new Error('TextRange: start offset out of bounds');
    this.startContainer = node;
    this.startOffset = offset;
  }

  setEnd(node, offset) {
    if (node.nodeType !== TEXT_NODE) throw new Error('TextRange: end must be a text node');
    if (offset < 0 || offset > node.data.length) throw new Error('TextRange: end offset out of bounds');
    this.endContainer = node;
    this.endOffset = offset;
  }

  toString() {
    const nodes = textNodesUnder(this.doc.documentElement);
    const from = nodes.indexOf(this.startContainer);
    const to = nodes.indexOf(this.endContainer);
    if (from < 0 || to < 0 || to < from) throw new Error('TextRange: invalid boundaries');
    if (from === to) return this.startContainer.data.slice(this.startOffset, this.endOffset);
    let text = this.startContainer.data.slice(this.startOffset);
    for (let i = from + 1; i < to; i++) text += nodes[i].data;
    return text + this.endContainer.data.slice(0, this.endOffset);
  }
}

// Make doc.createRange() return a TextRange.
export function installTextRange(doc) {
  doc.createRange = () => new TextRange(doc);
  return doc;
}
