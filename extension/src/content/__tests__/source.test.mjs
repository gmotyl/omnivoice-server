import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { articleContainer, articleSentences, selectionSentences, sentenceIndexAt } from '../source.mjs';
import { installTextRange } from './fake-range.mjs';

function dom(body, lang = 'en') {
  const { document } = parseHTML(
    `<!doctype html><html lang="${lang}"><head><title>Test page</title></head><body>${body}</body></html>`,
  );
  installTextRange(document);
  return document;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

const longParagraph = (n) =>
  `<p>Paragraph ${n} talks about the topic at length, with commas, details, and more words so that it scores well. ` +
  `It keeps going for a while longer here, adding context, examples, and some plain filler text.</p>`;

// Minimal Selection stand-in: one range with text-node boundaries.
function fakeSelection(startNode, startOffset, endNode, endOffset) {
  const range = { startContainer: startNode, startOffset, endContainer: endNode, endOffset };
  let a = startNode;
  const ancestors = new Set();
  for (let n = a; n; n = n.parentNode) ancestors.add(n);
  let common = endNode;
  while (common && !ancestors.has(common)) common = common.parentNode;
  range.commonAncestorContainer = common;
  return { rangeCount: 1, isCollapsed: false, getRangeAt: () => range };
}

test('articleContainer finds the live article element', () => {
  const doc = dom(`
    <nav><a href="/">Home</a> <a href="/about">About us</a> <a href="/blog">Blog</a></nav>
    <aside><p>Sidebar noise. Subscribe to the newsletter.</p></aside>
    <main><div class="wrap"><article id="art"><h1>Title of the article</h1>
      ${[1, 2, 3, 4, 5, 6].map(longParagraph).join('\n')}
    </article></div></main>
    <footer><p>Copyright notice.</p></footer>`);
  const container = articleContainer(doc);
  // the live element, not a node of Readability's clone
  assert.equal(container, doc.getElementById('art'));
  assert.equal(container.ownerDocument, doc);
  // the live DOM is left untouched
  assert.equal(doc.querySelector('[data-omnivoice-id]'), null);

  const sentences = articleSentences(doc, 'en');
  assert.equal(sentences[0].text, 'Title of the article');
  assert.ok(sentences.every((s) => !/Sidebar|Copyright|Home/.test(s.text)));
  assert.equal(sentences.length, 1 + 6 * 2);
});

test('falls back to body without chrome elements', () => {
  const doc = dom(`
    <header><p>Site header.</p></header>
    <nav><p>Menu entry.</p></nav>
    <p>First body sentence. Second body sentence.</p>
    <aside><p>Aside text.</p></aside>
    <div aria-hidden="true"><p>Hidden text.</p></div>
    <p>Last body sentence.</p>
    <footer><p>Footer text.</p></footer>`);
  class NullReadability {
    parse() {
      return null;
    }
  }
  assert.equal(articleContainer(doc, { Readability: NullReadability }), doc.body);
  const sentences = articleSentences(doc, 'en', { Readability: NullReadability });
  assert.deepEqual(sentences.map((s) => s.text), [
    'First body sentence.', 'Second body sentence.', 'Last body sentence.',
  ]);
  assert.deepEqual(sentences.map((s) => s.paragraph), [0, 0, 1]);
});

test('selection clips the first and last sentence', () => {
  const doc = dom(`<p id="a">Alpha one here. Bravo two here.</p><p id="b">Charlie three here. Delta four here.</p>`);
  const a = doc.getElementById('a').firstChild;
  const b = doc.getElementById('b').firstChild;
  // from "one here." in sentence 1 to "Delta four" in sentence 4
  const selection = fakeSelection(a, 'Alpha '.length, b, 'Charlie three here. Delta four'.length);
  const sentences = selectionSentences(doc, selection, 'en');
  assert.deepEqual(sentences.map((s) => s.text), [
    'one here.', 'Bravo two here.', 'Charlie three here.', 'Delta four',
  ]);
  assert.deepEqual(sentences.map((s) => s.paragraph), [0, 0, 1, 1]);
  assert.equal(sentences[0].range.startContainer, a);
  assert.equal(sentences[0].range.startOffset, 'Alpha '.length);
  assert.equal(sentences[3].range.endContainer, b);
  assert.equal(sentences[3].range.endOffset, 'Charlie three here. Delta four'.length);
  for (const s of sentences) {
    assert.equal(norm(s.range.toString()), s.text);
    assert.deepEqual(s.pieces, [s.text]);
  }
});

test('selection of two sentences yields two', () => {
  const doc = dom(`<p id="a">Before this. First <em>chosen</em> one. Second chosen one. After that.</p>`);
  const p = doc.getElementById('a');
  const head = p.firstChild; // "Before this. First "
  const tail = p.lastChild; // " one. Second chosen one. After that."
  const selection = fakeSelection(head, 'Before this. '.length, tail, ' one. Second chosen one.'.length);
  const sentences = selectionSentences(doc, selection, 'en');
  assert.deepEqual(sentences.map((s) => s.text), ['First chosen one.', 'Second chosen one.']);
  for (const s of sentences) assert.equal(norm(s.range.toString()), s.text);

  // collapsed or empty selections read nothing
  assert.deepEqual(selectionSentences(doc, { rangeCount: 0, isCollapsed: true }, 'en'), []);
});

test('sentenceIndexAt maps a node to its paragraph start', () => {
  const paragraphs = [];
  for (let n = 0; n < 9; n++) {
    paragraphs.push(n === 7
      ? `<p id="p7">Seventh starts here. Then <em id="hit">emphasis</em> follows. And ends.</p>`
      : `<p>Paragraph ${n} first. Paragraph ${n} second.</p>`);
  }
  const doc = dom(`<nav id="outside"><p>Outside text.</p></nav><div id="root">${paragraphs.join('')}</div>`);
  class NullReadability {
    parse() {
      return null;
    }
  }
  const sentences = articleSentences(doc, 'en', { Readability: NullReadability });
  const start = sentences.findIndex((s) => s.paragraph === 7);
  assert.equal(start, 7 * 2);
  assert.equal(sentences[start].text, 'Seventh starts here.');

  assert.equal(sentenceIndexAt(sentences, doc.getElementById('hit')), start);
  assert.equal(sentenceIndexAt(sentences, doc.getElementById('hit').firstChild), start);
  assert.equal(sentenceIndexAt(sentences, doc.getElementById('p7')), start);
  assert.equal(sentenceIndexAt(sentences, doc.getElementById('p7').lastChild), start);
  assert.equal(sentenceIndexAt(sentences, doc.getElementById('outside')), -1);
  assert.equal(sentenceIndexAt(sentences, doc.querySelector('#outside p').firstChild), -1);
});

test('body fallback reads bare text in containers', () => {
  const doc = dom(`<nav>Menu.</nav><div>Bare text. Second.</div><div><p>Para text.</p></div>`);
  class NullReadability {
    parse() {
      return null;
    }
  }
  const sentences = articleSentences(doc, 'en', { Readability: NullReadability });
  assert.deepEqual(sentences.map((s) => s.text), ['Bare text.', 'Second.', 'Para text.']);
});
