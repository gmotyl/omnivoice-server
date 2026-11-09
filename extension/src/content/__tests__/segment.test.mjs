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

test('English text is not guarded by Polish abbreviations', () => {
  const doc = dom(`<div id="root">
    <p>That is ok. Fine.</p>
    <p>The delay is 300 ms. Then it ends.</p>
    <p>Plan B. Next.</p>
    <p>Ask Mr. Smith today. He knows, e.g. the answer.</p>
  </div>`);
  const sentences = segment(doc.getElementById('root'), { lang: 'en-US', doc });
  assert.deepEqual(sentences.map((s) => s.text), [
    'That is ok.', 'Fine.',
    'The delay is 300 ms.', 'Then it ends.',
    'Plan B.', 'Next.',
    'Ask Mr. Smith today.', 'He knows, e.g. the answer.',
  ]);
});

test('abbreviation lists follow the language', () => {
  const doc = dom(`<p id="root">Jest ok. Dobrze.</p>`, 'pl');
  const root = doc.getElementById('root');
  // Polish "ok." (około) holds the sentence; in English "ok." ends it
  assert.deepEqual(segment(root, { lang: 'pl', doc }).map((s) => s.text), ['Jest ok. Dobrze.']);
  assert.deepEqual(segment(root, { lang: 'en', doc }).map((s) => s.text), ['Jest ok.', 'Dobrze.']);
  // single-letter initials after a lowercase word or at the start still hold the sentence
  const doc2 = dom(`<p id="root">Rozmawiałem z J. Kowalskim wczoraj. J. Nowak też był.</p>`, 'pl');
  assert.deepEqual(segment(doc2.getElementById('root'), { lang: 'pl', doc: doc2 }).map((s) => s.text), [
    'Rozmawiałem z J. Kowalskim wczoraj.', 'J. Nowak też był.',
  ]);
});

test('br separates sentences', () => {
  const doc = dom(`<p id="root">Line one.<br>Line two.<br/><br>Line three</p>`);
  const sentences = segment(doc.getElementById('root'), { lang: 'en', doc });
  assert.deepEqual(sentences.map((s) => s.text), ['Line one.', 'Line two.', 'Line three']);
  for (const s of sentences) assert.equal(norm(s.range.toString()), s.text);
  assert.deepEqual(sentences.map((s) => s.paragraph), [0, 0, 0]);
});

test('bare text in a container block is read once', () => {
  const doc = dom(`<section id="root">
    <div>Bare <em>text</em>. Second.</div>
    <div>Lead in div. <p>Inner paragraph.</p> Tail in div.</div>
    <article><p>Only the paragraph.</p></article>
  </section>`);
  const sentences = segment(doc.getElementById('root'), { lang: 'en', doc });
  assert.deepEqual(sentences.map((s) => s.text), [
    'Bare text.', 'Second.', 'Lead in div.', 'Inner paragraph.', 'Tail in div.', 'Only the paragraph.',
  ]);
  assert.deepEqual(sentences.map((s) => s.paragraph), [0, 0, 1, 2, 3, 4]);
  for (const s of sentences) assert.equal(norm(s.range.toString()), s.text);

  // a container root reads its own direct text too
  const doc2 = dom(`<div id="root">Direct text here.</div>`);
  assert.deepEqual(segment(doc2.getElementById('root'), { lang: 'en', doc: doc2 }).map((s) => s.text), [
    'Direct text here.',
  ]);
});

test('hard cut keeps pieces within the limit', () => {
  const word = 'x'.repeat(1000);
  const pieces = cutPieces(word);
  assert.deepEqual(pieces.map((p) => p.length), [400, 400, 200]);
  // hard-cut pieces join without a separator; space cuts drop the space
  assert.equal(pieces.join(''), word);

  const mixed = `${'y'.repeat(450)} tail words`;
  const mixedPieces = cutPieces(mixed);
  for (const piece of mixedPieces) assert.ok(piece.length <= 400);
  assert.deepEqual(mixedPieces, ['y'.repeat(400), `${'y'.repeat(50)} tail words`]);

  // never split a surrogate pair
  const emoji = 'a' + '😀'.repeat(300); // 601 UTF-16 units, a pair straddles unit 400
  const emojiPieces = cutPieces(emoji);
  for (const piece of emojiPieces) {
    assert.ok(piece.length <= 400);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(piece));
  }
  assert.equal(emojiPieces.join(''), emoji);
});

test('table header cells and rows are separate runs', () => {
  const doc = dom(`<table id="root"><caption>People</caption><tr><th>Name</th><th>Age</th></tr><tr><td>Ann</td><td>30</td></tr></table>`);
  const sentences = segment(doc.getElementById('root'), { lang: 'en', doc });
  assert.deepEqual(sentences.map((s) => s.text), ['People', 'Name', 'Age', 'Ann', '30']);
  for (const s of sentences) assert.equal(norm(s.range.toString()), s.text);
});

test('form controls are not read', () => {
  const doc = dom(`<div id="root"><p>Choose an option.</p><button>Save</button><button>Cancel</button><label>Pick</label><select><option>One</option><option>Two</option></select><textarea>Draft</textarea><p>After the form.</p></div>`);
  const sentences = segment(doc.getElementById('root'), { lang: 'en', doc });
  assert.deepEqual(sentences.map((s) => s.text), ['Choose an option.', 'After the form.']);
});

test('lists break runs between items and surrounding text', () => {
  const doc = dom(`<div id="root">Lead text<ul><li>One</li></ul>tail text<dl><dt>Term</dt><dd>Meaning</dd></dl></div>`);
  const sentences = segment(doc.getElementById('root'), { lang: 'en', doc });
  assert.deepEqual(sentences.map((s) => s.text), ['Lead text', 'One', 'tail text', 'Term', 'Meaning']);
});

test('text directly inside a list is a run of its own', () => {
  const doc = dom(`<div id="root">Lead text<ul>List heading<li>One</li></ul>tail text</div>`);
  const sentences = segment(doc.getElementById('root'), { lang: 'en', doc });
  assert.deepEqual(sentences.map((s) => s.text), ['Lead text', 'List heading', 'One', 'tail text']);
});
