import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { segment, cutPieces } from '../segment.mjs';
import { installTextRange } from './fake-range.mjs';

function dom(body, lang = 'en') {
  const { document } = parseHTML(`<!doctype html><html lang="${lang}"><body>${body}</body></html>`);
  installTextRange(document);
  return document;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

test('splits paragraphs into sentences with paragraph indexes', () => {
  const doc = dom(`<article id="root">
    <p>First one here. Second one here.</p>
    <p>Third one here. Fourth one here.</p>
    <p>Fifth one here. Sixth one here.</p>
  </article>`);
  const sentences = segment(doc.getElementById('root'), { lang: 'en', doc });
  assert.equal(sentences.length, 6);
  assert.deepEqual(sentences.map((s) => s.paragraph), [0, 0, 1, 1, 2, 2]);
  assert.deepEqual(sentences.map((s) => s.text), [
    'First one here.', 'Second one here.',
    'Third one here.', 'Fourth one here.',
    'Fifth one here.', 'Sixth one here.',
  ]);
  for (const s of sentences) assert.deepEqual(s.pieces, [s.text]);
});

test('does not break after Polish abbreviations or inside decimal commas', () => {
  const doc = dom(`<div id="root">
    <p>Przerwa trwa ok. 1,5 s i potem wraca. Mówi np. tak, jak trzeba.</p>
    <p>Rozmawiałem z prof. Nowakiem wczoraj. Byli tam m.in. Jan i Ewa.</p>
  </div>`, 'pl');
  const sentences = segment(doc.getElementById('root'), { lang: 'pl', doc });
  assert.deepEqual(sentences.map((s) => s.text), [
    'Przerwa trwa ok. 1,5 s i potem wraca.',
    'Mówi np. tak, jak trzeba.',
    'Rozmawiałem z prof. Nowakiem wczoraj.',
    'Byli tam m.in. Jan i Ewa.',
  ]);
});

test('sentence range covers text across inline elements', () => {
  const doc = dom(`<p id="root">Read <a href="#">the <em>linked</em> page</a> now. Then <em>stop</em>.</p>`);
  const sentences = segment(doc.getElementById('root'), { lang: 'en', doc });
  assert.equal(sentences.length, 2);

  const [first, second] = sentences;
  const p = doc.getElementById('root');
  assert.equal(first.text, 'Read the linked page now.');
  assert.equal(first.range.startContainer, p.firstChild); // "Read "
  assert.equal(first.range.startOffset, 0);
  const afterLink = p.querySelector('a').nextSibling; // " now. Then "
  assert.equal(first.range.endContainer, afterLink);
  assert.equal(first.range.endOffset, ' now.'.length);
  assert.equal(norm(first.range.toString()), first.text);

  assert.equal(second.text, 'Then stop.');
  assert.equal(second.range.startContainer, afterLink);
  assert.equal(second.range.startOffset, ' now. '.length);
  assert.equal(second.range.endContainer, p.lastChild); // "."
  assert.equal(second.range.endOffset, 1);
  assert.equal(norm(second.range.toString()), second.text);
});

test('nested blocks are counted once', () => {
  const doc = dom(`<ul id="root">
    <li><p>Inside a paragraph.</p></li>
    <li>Plain item.</li>
    <li>Lead text. <blockquote><p>Quoted line.</p></blockquote> Tail text.</li>
  </ul>`);
  const sentences = segment(doc.getElementById('root'), { lang: 'en', doc });
  assert.deepEqual(sentences.map((s) => s.text), [
    'Inside a paragraph.', 'Plain item.', 'Lead text.', 'Quoted line.', 'Tail text.',
  ]);
  for (const s of sentences) assert.equal(norm(s.range.toString()), s.text);
  // each contiguous run is its own paragraph, in document order
  assert.deepEqual(sentences.map((s) => s.paragraph), [0, 1, 2, 3, 4]);
});

test('skips empty, hidden and script blocks', () => {
  const doc = dom(`<div id="root">
    <p></p>
    <p>   \n\t  </p>
    <p>Visible one.</p>
    <div aria-hidden="true"><p>Hidden text.</p></div>
    <script>var x = "<p>Script text.</p>";</script>
    <style>p { color: red }</style>
    <noscript><p>Noscript text.</p></noscript>
    <p>Visible <span aria-hidden="true">secret </span>two.</p>
  </div>`);
  const sentences = segment(doc.getElementById('root'), { lang: 'en', doc });
  assert.deepEqual(sentences.map((s) => s.text), ['Visible one.', 'Visible two.']);
  assert.deepEqual(sentences.map((s) => s.paragraph), [0, 1]);
});

test('cuts long sentences into pieces at spaces', () => {
  const words = [];
  for (let i = 0; words.join(' ').length < 1000; i++) words.push(`word${i}`);
  const long = words.join(' ') + '.';

  const pieces = cutPieces(long);
  assert.ok(pieces.length >= 3);
  for (const piece of pieces) {
    assert.ok(piece.length <= 400, `piece too long: ${piece.length}`);
    assert.ok(!piece.startsWith(' ') && !piece.endsWith(' '));
  }
  assert.equal(pieces.join(' '), long);
  // cut at the last space before the limit: the next word would not have fitted
  for (let i = 0; i < pieces.length - 1; i++) {
    const nextWord = pieces[i + 1].split(' ')[0];
    assert.ok(pieces[i].length + 1 + nextWord.length > 400);
  }
  assert.deepEqual(cutPieces('short text'), ['short text']);
  assert.deepEqual(cutPieces('aaa bbb ccc', 7), ['aaa bbb', 'ccc']);

  const doc = dom(`<p id="root">${long}</p>`);
  const [sentence] = segment(doc.getElementById('root'), { lang: 'en', doc });
  assert.equal(sentence.text, long);
  assert.deepEqual(sentence.pieces, pieces);
});
