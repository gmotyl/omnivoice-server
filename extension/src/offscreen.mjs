// Offscreen document entry: owns the sentence queue and the <audio> element.
// The service worker relays content-script commands here; we answer with
// `sentence-start` / `state` messages, which it forwards to the owning tab.
import { speak } from "./engine.mjs";
import { createQueue } from "./offscreen/queue.mjs";
import { createPlayer } from "./offscreen/player.mjs";

const DEFAULTS = { baseUrl: "http://localhost:8892/v1", apiKey: "", voice: "", speed: 1, model: "tts-1" };

const settings = { ...DEFAULTS };

// Settings are re-read on every `play`, so options changes apply to the next session.
async function loadSettings() {
  const sync = globalThis.chrome?.storage?.sync;
  if (!sync) return settings;
  Object.assign(settings, DEFAULTS, await sync.get(DEFAULTS));
  return settings;
}

const send = (msg) => {
  // No listener (service worker restarting) is not worth surfacing here.
  Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => {});
};

const queue = createQueue({
  fetchAudio: (text, voice, signal) => speak(settings, { text, voice }, signal),
});

const player = createPlayer({ queue, audio: new Audio(), emit: send, settings });

// Bumped by every play/stop, so a stop that lands while settings load cancels that play.
let playToken = 0;

chrome.runtime.onMessage.addListener((msg, sender) => {
  // Content scripts' runtime messages reach every extension page; only act on the
  // copies the service worker relays, so each command is handled once.
  if (sender?.tab || !msg || typeof msg.type !== "string") return;
  switch (msg.type) {
    case "play": {
      const token = ++playToken;
      loadSettings().then(
        () =>
          token === playToken &&
          player.play({
            sentences: msg.sentences,
            start: msg.start,
            voice: msg.voice ?? settings.voice,
            speed: msg.speed ?? settings.speed,
          }),
        (err) => token === playToken && send({ type: "state", state: "error", error: err?.message || String(err) }),
      );
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
      playToken++;
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
