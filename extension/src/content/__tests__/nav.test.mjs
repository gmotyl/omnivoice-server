import { test } from 'node:test';
import assert from 'node:assert/strict';
import { next, prev, nextParagraph, prevParagraph } from '../nav.mjs';

// Paragraph layout: p0 = [0,1], p1 = [2,3], p2 = [4,5,6], p3 = [7,8,9]
const sentences = [0, 0, 1, 1, 2, 2, 2, 3, 3, 3].map((paragraph) => ({ paragraph }));

test('next moves one sentence', () => {
  assert.equal(next(sentences, 4), 5);
});

test('prevParagraph goes to the current paragraph start', () => {
  assert.equal(prevParagraph(sentences, 8), 7);
  assert.equal(prevParagraph(sentences, 9), 7);
});

test('prevParagraph at a paragraph start goes to the previous one', () => {
  assert.equal(prevParagraph(sentences, 7), 4);
  assert.equal(prevParagraph(sentences, 2), 0);
  assert.equal(prevParagraph(sentences, 0), 0);
});

test('prev at the first sentence stays at 0', () => {
  assert.equal(prev(sentences, 0), 0);
  assert.equal(prev(sentences, 3), 2);
});

test('next and nextParagraph at the end return null', () => {
  const last = sentences.length - 1;
  assert.equal(next(sentences, last), null);
  assert.equal(nextParagraph(sentences, last), null);
  assert.equal(nextParagraph(sentences, 7), null);
  assert.equal(nextParagraph(sentences, 5), 7);
});
