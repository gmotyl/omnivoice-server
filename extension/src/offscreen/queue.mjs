// Prefetching sentence queue for the offscreen player.
// A sentence is an array of ≤400-char pieces; its audio is the ArrayBuffer[]
// of those pieces, fetched one after another in order.

/**
 * @param {{fetchAudio: (text: string, voice: string, signal: AbortSignal) => Promise<ArrayBuffer>, prefetch?: number}} opts
 */
export function createQueue({ fetchAudio, prefetch = 3 }) {
  let sentences = [];
  let voice;
  let cursor = 0;
  /** @type {Map<number, {controller: AbortController, promise: Promise<ArrayBuffer[]>, settled: boolean}>} */
  const cache = new Map();

  async function fetchSentence(pieces, v, signal) {
    const audio = [];
    for (const piece of pieces) {
      signal.throwIfAborted();
      audio.push(await fetchAudio(piece, v, signal));
    }
    return audio;
  }

  function start(index) {
    let entry = cache.get(index);
    if (entry) return entry;
    const controller = new AbortController();
    const promise = fetchSentence(sentences[index], voice, controller.signal);
    // Prefetched or aborted entries may never be awaited; keep their rejection handled.
    entry = { controller, promise, settled: false };
    const settle = () => { entry.settled = true; };
    promise.then(settle, settle);
    cache.set(index, entry);
    return entry;
  }

  function drop(index) {
    const entry = cache.get(index);
    if (!entry) return;
    entry.controller.abort();
    cache.delete(index);
  }

  // Move the window to [index, index + prefetch] and start everything inside it.
  // Outside the window, `abortInFlight` (seek) aborts pending requests too;
  // otherwise (get) only settled audio is evicted, so a caller still awaiting
  // an earlier sentence is not cut off.
  function moveTo(index, abortInFlight) {
    cursor = index;
    const last = Math.min(index + prefetch, sentences.length - 1);
    for (const [i, entry] of [...cache]) {
      if ((i < index || i > last) && (abortInFlight || entry.settled)) drop(i);
    }
    for (let i = index; i <= last; i++) start(i);
  }

  function inRange(index) {
    return Number.isInteger(index) && index >= 0 && index < sentences.length;
  }

  function clear() {
    for (const i of [...cache.keys()]) drop(i);
  }

  return {
    load(newSentences, newVoice) {
      clear();
      sentences = newSentences;
      voice = newVoice;
      cursor = 0;
    },
    get(index) {
      if (!inRange(index)) return Promise.reject(new RangeError(`no sentence at index ${index}`));
      moveTo(index, false);
      return cache.get(index).promise;
    },
    seek(index) {
      if (inRange(index)) moveTo(index, true);
    },
    setVoice(newVoice) {
      voice = newVoice;
      const hadWindow = cache.size > 0;
      clear();
      if (hadWindow && inRange(cursor)) moveTo(cursor, true);
    },
    clear,
  };
}
