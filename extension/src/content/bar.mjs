// Player bar: one host element with a closed shadow root, so page CSS cannot style it
// and page scripts cannot reach its controls. The host is a custom tag (never matched by
// page rules on div) and carries an inline `all: initial !important` reset, which beats
// any page stylesheet rule that still targets it (e.g. `* { transform: … }`).

const HOST_TAG = 'omnivoice-reader-bar';
const HOST_STYLE = 'all: initial !important;';

// Inline SVG icons: unicode media glyphs render as tofu without a symbol font.
const svg = (body) =>
  `<svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">${body}</svg>`;
const ICONS = {
  prev: svg('<rect x="2" y="3" width="2" height="10"/><path d="M14 3v10L5 8z"/>'),
  next: svg('<rect x="12" y="3" width="2" height="10"/><path d="M2 3v10l9-5z"/>'),
  play: svg('<path d="M4 2.5v11L13.5 8z"/>'),
  pause: svg('<rect x="3.5" y="2.5" width="3" height="11"/><rect x="9.5" y="2.5" width="3" height="11"/>'),
  close: svg('<path d="M3.5 2.1 8 6.6l4.5-4.5 1.4 1.4L9.4 8l4.5 4.5-1.4 1.4L8 9.4l-4.5 4.5-1.4-1.4L6.6 8 2.1 3.5z"/>'),
};

const STYLE = `
  :host { all: initial; }
  .bar {
    position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
    z-index: 2147483647; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    padding: 8px 12px; border-radius: 10px; background: #1f2328; color: #f6f8fa;
    font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  }
  button svg { display: block; }
  button, select { font: inherit; color: inherit; background: #2d333b; border: 1px solid #444c56;
    border-radius: 6px; padding: 4px 8px; cursor: pointer; }
  button:focus-visible, select:focus-visible, input:focus-visible, a:focus-visible {
    outline: 2px solid #58a6ff; outline-offset: 1px; }
  .speed-value { min-width: 2.5em; text-align: right; }
  .error { flex-basis: 100%; display: flex; gap: 8px; align-items: center; color: #ffb4ab; }
  .error[hidden] { display: none; }
  .error a { color: #58a6ff; }
`;

const TEMPLATE = `
  <style>${STYLE}</style>
  <div class="bar" role="toolbar" aria-label="Reader">
    <button type="button" class="prev" aria-label="Previous" title="Previous sentence (Shift: paragraph)">${ICONS.prev}</button>
    <button type="button" class="toggle" aria-label="Play">${ICONS.play}</button>
    <button type="button" class="next" aria-label="Next" title="Next sentence (Shift: paragraph)">${ICONS.next}</button>
    <select class="voice" aria-label="Voice"></select>
    <input class="speed" type="range" min="0.5" max="2" step="0.1" value="1" aria-label="Speed">
    <span class="speed-value">1.0&times;</span>
    <button type="button" class="close" aria-label="Close">${ICONS.close}</button>
    <div class="error" role="alert" hidden>
      <span class="message"></span>
      <a class="options" href="#">Open options</a>
      <button type="button" class="retry" aria-label="Retry">Retry</button>
    </div>
  </div>
`;

const PLAYING_STATES = new Set(['playing', 'loading']);

export function createBar({ doc = globalThis.document, onAction = () => {} } = {}) {
  const host = doc.createElement(HOST_TAG);
  host.setAttribute('data-omnivoice-reader', 'bar');
  host.setAttribute('style', HOST_STYLE);
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = TEMPLATE;
  (doc.body || doc.documentElement).appendChild(host);

  const $ = (sel) => root.querySelector(sel);
  const toggle = $('.toggle');
  const voice = $('.voice');
  const speed = $('.speed');
  const speedValue = $('.speed-value');
  const error = $('.error');
  const message = $('.message');

  const on = (el, type, fn) => el.addEventListener(type, fn);
  on(toggle, 'click', () => onAction('toggle'));
  on($('.prev'), 'click', (e) => onAction(e.shiftKey ? 'prev-paragraph' : 'prev'));
  on($('.next'), 'click', (e) => onAction(e.shiftKey ? 'next-paragraph' : 'next'));
  on($('.close'), 'click', () => onAction('close'));
  on($('.retry'), 'click', () => onAction('retry'));
  on($('.options'), 'click', (e) => { e.preventDefault(); onAction('options'); });
  on(voice, 'change', () => onAction('voice', voice.value));
  on(speed, 'input', () => {
    const s = Math.round(Number(speed.value) * 10) / 10;
    showSpeed(s);
    onAction('speed', s);
  });

  function showSpeed(s) {
    speedValue.textContent = `${Number(s).toFixed(1)}×`;
  }

  function setState(state, err) {
    const playing = PLAYING_STATES.has(state);
    toggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    toggle.innerHTML = playing ? ICONS.pause : ICONS.play;
    if (state === 'error') {
      message.textContent = String(err ?? 'Something went wrong');
      error.removeAttribute('hidden');
    } else {
      message.textContent = '';
      error.setAttribute('hidden', '');
    }
  }

  // list === null means the engine gave no voice list: show only the current voice.
  function setVoices(list, current) {
    const ids = list ?? (current ? [current] : []);
    voice.textContent = '';
    for (const id of ids) {
      const opt = doc.createElement('option');
      opt.value = id;
      opt.textContent = id;
      if (id === current) opt.setAttribute('selected', '');
      voice.appendChild(opt);
    }
    if (list === null) voice.setAttribute('disabled', '');
    else voice.removeAttribute('disabled');
  }

  function setSpeed(s) {
    speed.value = String(s);
    showSpeed(s);
  }

  function destroy() {
    host.remove();
  }

  return { setState, setVoices, setSpeed, destroy };
}
