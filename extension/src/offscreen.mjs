// Offscreen document entry: owns the sentence queue and the <audio> element.
// The service worker relays content-script commands here; we answer with
// `sentence-start` / `state` messages, which it forwards to the owning tab.
// Engine settings ({baseUrl, apiKey, model}) arrive with each `play`: the service worker
// reads chrome.storage, which offscreen documents cannot use (they only get chrome.runtime).
import { speak as engineSpeak } from "./engine.mjs";
import { createQueue } from "./offscreen/queue.mjs";
import { createPlayer } from "./offscreen/player.mjs";

const ENGINE_DEFAULTS = { baseUrl: "http://localhost:8892/v1", apiKey: "", model: "tts-1" };

// deps: {runtime: chrome.runtime, audio: HTMLAudioElement, speak} — injectable for tests.
export function createOffscreen({ runtime, audio, speak = engineSpeak }) {
  // Replaced on every `play`, so options changes apply to the next session.
  let settings = { ...ENGINE_DEFAULTS };

  const send = (msg) => {
    // No listener (service worker restarting) is not worth surfacing here.
    try {
      Promise.resolve(runtime.sendMessage(msg)).catch(() => {});
    } catch {
      // extension context gone
    }
  };

  const queue = createQueue({
    fetchAudio: (text, voice, signal) => speak(settings, { text, voice }, signal),
  });

  const player = createPlayer({ queue, audio, emit: send });

  runtime.onMessage.addListener((msg, sender) => {
    // Content scripts' runtime messages reach every extension page; only act on the
    // copies the service worker relays (stamped `target: "offscreen"`), so each command
    // is handled once.
    if (sender?.tab || !msg || msg.target !== "offscreen" || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "play": {
        const { baseUrl, apiKey, model } = { ...ENGINE_DEFAULTS, ...(msg.settings || {}) };
        settings = { baseUrl, apiKey, model };
        player.play({ sentences: msg.sentences, start: msg.start, voice: msg.voice ?? "", speed: msg.speed ?? 1 });
        break;
      }
      case "seek":
        player.seek(msg.index);
        break;
      case "pause":
        player.pause();
        break;
      case "resume":
        player.resume();
        break;
      case "stop":
        player.stop();
        break;
      case "set-speed":
        player.setSpeed(msg.speed);
        break;
      case "set-voice":
        player.setVoice(msg.voice);
        break;
    }
  });

  return { player };
}

// Real offscreen document only, not when imported by tests.
if (globalThis.chrome?.runtime?.id && typeof Audio !== "undefined") {
  createOffscreen({ runtime: globalThis.chrome.runtime, audio: new Audio() });
}
