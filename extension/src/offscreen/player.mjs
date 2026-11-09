// Offscreen audio player: walks the sentence queue, plays each sentence's pieces in order
// through one audio element, and reports progress via `sentence-start` / `state` messages.
//
// Every navigation (play, seek, setVoice, stop) bumps `generation`; async work from an
// older generation is dropped, so a late queue result can never play over a newer one.

const isAbort = (err) => err?.name === "AbortError";

/**
 * @param {{
 *   queue: ReturnType<typeof import("./queue.mjs").createQueue>,
 *   audio: HTMLAudioElement,
 *   emit: (msg: object) => void,
 *   settings?: {voice?: string, speed?: number},
 *   url?: {createObjectURL: (b: Blob) => string, revokeObjectURL: (u: string) => void},
 *   Blob?: typeof Blob,
 * }} opts
 */
export function createPlayer({
  queue,
  audio,
  emit,
  settings = {},
  url = globalThis.URL,
  Blob: BlobImpl = globalThis.Blob,
}) {
  let sentences = null;
  let index = 0;
  let pieces = [];
  let piece = 0;
  let voice = settings.voice;
  let speed = settings.speed ?? 1;
  let state = "idle";
  let paused = false; // user paused; survives a sentence still loading
  let ready = false; // audio.src holds a piece of the current sentence
  let endedWhilePaused = false; // the piece finished as the user paused; resume moves on
  let currentUrl = null;
  let generation = 0;

  function setState(next, error) {
    if (next === state && next !== "error") return;
    state = next;
    emit(error === undefined ? { type: "state", state: next } : { type: "state", state: next, error });
  }

  function applySpeed() {
    audio.defaultPlaybackRate = speed;
    audio.playbackRate = speed;
    audio.preservesPitch = true;
  }

  function releaseAudio() {
    audio.pause();
    ready = false;
    endedWhilePaused = false;
    if (currentUrl) {
      // Detach the revoked blob so the element drops its decoded buffer.
      audio.removeAttribute?.("src");
      audio.load?.();
      url.revokeObjectURL(currentUrl);
      currentUrl = null;
    }
  }

  function fail(err) {
    generation++;
    releaseAudio();
    queue.clear();
    paused = false;
    setState("error", err?.message || String(err));
  }

  function startAudio() {
    const g = generation;
    Promise.resolve(audio.play()).catch((err) => {
      // play() interrupted by pause/new src rejects with AbortError — not a failure.
      if (g === generation && !isAbort(err)) fail(err);
    });
  }

  function playPiece(k) {
    piece = k;
    endedWhilePaused = false;
    if (currentUrl) url.revokeObjectURL(currentUrl);
    currentUrl = url.createObjectURL(new BlobImpl([pieces[k]], { type: "audio/mpeg" }));
    audio.src = currentUrl;
    applySpeed(); // a new src resets playbackRate to the default
    ready = true;
    if (!paused) startAudio();
  }

  async function startSentence(i) {
    const g = ++generation;
    releaseAudio();
    index = i;
    if (!paused) setState("loading");
    let audioPieces;
    try {
      audioPieces = await queue.get(i);
    } catch (err) {
      // Aborts come from our own seek/setVoice/stop; anything else is an engine failure.
      if (g === generation && !isAbort(err)) fail(err);
      return;
    }
    if (g !== generation) return;
    pieces = audioPieces;
    emit({ type: "sentence-start", index: i });
    if (pieces.length === 0) return next();
    playPiece(0);
    setState(paused ? "paused" : "playing");
  }

  function next() {
    if (piece + 1 < pieces.length) return playPiece(piece + 1);
    if (index + 1 < sentences.length) return void startSentence(index + 1);
    stopSession("idle");
  }

  function stopSession(finalState) {
    generation++;
    releaseAudio();
    queue.clear();
    paused = false;
    pieces = [];
    setState(finalState);
  }

  function pieceEnded() {
    if (currentUrl) {
      url.revokeObjectURL(currentUrl);
      currentUrl = null;
    }
    ready = false;
    next();
  }

  audio.addEventListener("ended", () => {
    if (!sentences || !ready) return;
    if (state === "playing") return pieceEnded();
    // `ended` raced a pause: resuming would replay the finished piece, so remember it.
    if (state === "paused") endedWhilePaused = true;
  });

  audio.addEventListener("error", () => {
    if (sentences && ready) fail(new Error("Audio playback failed"));
  });

  return {
    play({ sentences: newSentences, start = 0, voice: newVoice, speed: newSpeed }) {
      generation++;
      releaseAudio();
      sentences = newSentences;
      voice = newVoice ?? voice;
      if (newSpeed !== undefined) speed = newSpeed;
      paused = false;
      queue.load(sentences, voice);
      if (!sentences.length) return stopSession("idle");
      // A new session always reports loading, even if the previous one was loading too.
      state = null;
      void startSentence(Math.min(Math.max(0, start), sentences.length - 1));
    },
    seek(i) {
      if (!sentences || !Number.isInteger(i) || i < 0 || i >= sentences.length) return;
      paused = false;
      queue.seek(i);
      void startSentence(i);
    },
    pause() {
      if (!sentences || paused || (state !== "playing" && state !== "loading")) return;
      paused = true;
      audio.pause();
      setState("paused");
    },
    resume() {
      if (!sentences || !paused) return;
      paused = false;
      if (ready && (endedWhilePaused || audio.ended)) {
        setState("playing");
        pieceEnded();
      } else if (ready) {
        startAudio();
        setState("playing");
      } else {
        setState("loading");
      }
    },
    stop() {
      sentences = null;
      stopSession("idle");
    },
    setSpeed(s) {
      speed = s;
      applySpeed();
    },
    setVoice(v) {
      voice = v;
      queue.setVoice(v);
      // Restart the current sentence in the new voice, unless there is no live session.
      if (sentences && (state === "playing" || state === "loading" || state === "paused")) {
        void startSentence(index);
      }
    },
  };
}
