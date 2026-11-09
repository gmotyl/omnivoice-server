// Pure navigation over the segmented sentence list.
// Each sentence carries a `paragraph` index; indexes are positions in `sentences`.

// Index of the first sentence in the paragraph that contains sentence i.
function paragraphStart(sentences, i) {
  const p = sentences[i].paragraph;
  let s = i;
  while (s > 0 && sentences[s - 1].paragraph === p) s--;
  return s;
}

export function next(sentences, i) {
  return i + 1 < sentences.length ? i + 1 : null;
}

export function prev(sentences, i) {
  return i > 0 ? i - 1 : 0;
}

export function nextParagraph(sentences, i) {
  const p = sentences[i].paragraph;
  for (let s = i + 1; s < sentences.length; s++) {
    if (sentences[s].paragraph !== p) return s;
  }
  return null;
}

export function prevParagraph(sentences, i) {
  const start = paragraphStart(sentences, i);
  if (start !== i) return start;
  return start > 0 ? paragraphStart(sentences, start - 1) : 0;
}
