# Reader extension Implementation Plan

> **For agentic workers:** implement this plan with [[pavilio-execute-plan]] — task-by-task, top-down; check off each step (`- [ ]` → `- [x]`) as it lands. Do one task fully (test → implement → verify → commit) before starting the next.

**Goal:** A Manifest V3 Chrome/Edge extension in `extension/` that reads the page's article or the selection aloud through an OpenAI-compatible `/audio/speech` engine, with sentence/paragraph navigation, Alt+click start and in-place highlighting.

**Architecture:** The content script segments the original DOM into sentences (Readability only locates the container), highlights with the CSS Custom Highlight API and draws the player bar in Shadow DOM. An offscreen document owns the sentence queue (prefetch 3, abort on seek) and the `<audio>` element. The service worker handles triggers, injection, single-session ownership and message routing.

**Tech Stack:** Plain JS ES modules, Node 22+, esbuild (content bundle), `@mozilla/readability`, `linkedom` (tests), `node --test`.

**Design:** [design.md](./design.md) · **Spec:** [specs/reader-extension/spec.md](./specs/reader-extension/spec.md)

---

All commands run in `extension/`. Test command: `npm test` (= `node --test src/`). Tests live in `__tests__/` next to the code under test. Chrome APIs (`chrome.*`), `Audio`, `fetch` and `CSS.highlights` are injected or faked in tests — modules take them as parameters or read them from `globalThis` so they can be replaced.

**Contract — messages** (all `{type, ...}` via `chrome.runtime` messaging; the service worker relays between tab and offscreen and stamps `tabId`):

| type | direction | payload |
| --- | --- | --- |
| `play` | content → sw → offscreen | `{sentences: string[][], start: number, voice, speed}` (each sentence = its ≤400-char pieces) |
| `seek` | content → sw → offscreen | `{index}` |
| `pause` / `resume` / `stop` | content or sw → offscreen | — |
| `set-speed` | content → sw → offscreen | `{speed}` |
| `set-voice` | content → sw → offscreen | `{voice}` |
| `sentence-start` | offscreen → sw → content | `{index}` |
| `state` | offscreen → sw → content | `{state: "loading"\|"playing"\|"paused"\|"idle"\|"error", error?}` |
| `toggle` | sw → content | — (shortcut) |
| `start` | sw → content | `{source: "auto"\|"selection"\|"from-here", x?, y?}` |

### Task 1: Scaffold, manifest and build

**Files:**
- Create: `extension/package.json`, `extension/manifest.json`, `extension/build.mjs`, `extension/.gitignore` (`dist/`, `node_modules/`), `extension/src/__tests__/manifest.test.mjs`, placeholder entry files referenced by the manifest (`src/background.mjs`, `src/content/main.mjs`, `src/offscreen.html`, `src/offscreen.mjs`, `src/options.html`, `src/options.mjs`), `extension/icons/` (16/48/128 PNG, simple speaker glyph)

**Contract:**
- `package.json`: `"type": "module"`, `"private": true`, `engines.node >= 22`, scripts `test` = `node --test src/`, `build` = `node build.mjs`; deps `@mozilla/readability`; devDeps `esbuild`, `linkedom`.
- `manifest.json`: `manifest_version: 3`; `permissions: ["activeTab","scripting","offscreen","contextMenus","storage"]`; `host_permissions: ["http://localhost/*","http://127.0.0.1/*"]`; `optional_host_permissions: ["http://*/*","https://*/*"]`; `background.service_worker: "src/background.mjs"`, `"type": "module"`; `options_page: "src/options.html"`; `commands.toggle-reading.suggested_key.default: "Alt+Shift+R"`; `action` with icons; no `content_scripts` (injected on demand: `dist/content.js`).
- `build.mjs`: esbuild bundles `src/content/main.mjs` → `dist/content.js` (IIFE, no sourcemap URL to remote).

**Acceptance criteria:**
- WHEN the manifest is parsed THEN `host_permissions` holds only localhost and 127.0.0.1 origins and no `<all_urls>` appears anywhere
- WHEN any HTML/JS file under `src/` or `dist/` is scanned THEN no `<script src="http…">` or `import "http…"` exists
- WHEN `npm run build` runs THEN `dist/content.js` exists and every path named in the manifest exists on disk

**Tests (names only — red first):**
- "manifest host_permissions are localhost-only"
- "manifest has no all-sites permission"
- "no remote script is referenced"
- "every manifest path exists after build"

- [x] **Step 1: Write the failing tests** — Run: `npm install && npm test` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `npm run build && npm test` — Expected: PASS
- [x] **Step 3: Commit** — `git add extension && git commit -m "feat(extension): scaffold MV3 manifest and build"`

### Task 2: Engine client

**Files:**
- Create: `extension/src/engine.mjs`
- Test: `extension/src/__tests__/engine.test.mjs`

**Contract:**
```js
// settings: {baseUrl, apiKey, model}
export async function listVoices(settings, fetchImpl = fetch) // → {voices: string[] | null, ok: true} | {ok: false, error}
export async function speak(settings, {text, voice}, signal, fetchImpl = fetch) // → ArrayBuffer (audio/mpeg); throws EngineError {status, message}
```

**Acceptance criteria:**
- WHEN `speak` runs THEN it POSTs `{baseUrl}/audio/speech` with JSON `{model, input, voice}` and `content-type: application/json`
- WHEN `apiKey` is set THEN `Authorization: Bearer <key>` is sent; WHEN empty THEN no `Authorization` header
- WHEN the engine answers non-2xx THEN `EngineError` carries the status and the body's `error.message` (or text)
- WHEN `signal` aborts THEN the promise rejects with an `AbortError` (not an `EngineError`)
- WHEN `GET {baseUrl}/audio/voices` returns `{voices:[…]}` THEN `listVoices` returns those ids
- WHEN `/audio/voices` fails and `GET {baseUrl}/models` succeeds THEN `listVoices` returns `{ok: true, voices: null}` (free-text voice)
- WHEN both fail THEN `{ok: false, error}`
- WHEN `baseUrl` has a trailing slash THEN URLs have no double slash

**Tests (names only — red first):**
- "speak posts model, input and voice to /audio/speech"
- "speak sends bearer only when a key is set"
- "speak maps http errors to EngineError"
- "speak abort rejects with AbortError"
- "listVoices returns ids from /audio/voices"
- "listVoices falls back to /models with free-text voice"
- "listVoices reports failure when both endpoints fail"
- "trailing slash in baseUrl is normalised"

- [x] **Step 1: Write the failing tests** — Run: `npm test` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `npm test` — Expected: PASS
- [x] **Step 3: Commit** — `git commit -m "feat(extension): OpenAI-compatible engine client"`

### Task 3: Segmentation

**Files:**
- Create: `extension/src/content/segment.mjs`
- Test: `extension/src/content/__tests__/segment.test.mjs`

**Contract:**
```js
// Sentence: {text, pieces: string[], range: Range, paragraph: number}
export function segment(root, {lang, doc}) // → Sentence[] over block elements (p, li, h1–h6, blockquote, pre, td, dd, figcaption) in document order
export function cutPieces(text, max = 400) // → string[] cut at the last space ≤ max
```

**Acceptance criteria:**
- WHEN a container has 3 paragraphs of 2 sentences THEN 6 sentences with paragraph indexes 0,0,1,1,2,2
- WHEN Polish text contains `ok. 1,5 s` or `np. tak` THEN no sentence break after `ok.`/`np.` or inside `1,5` (Intl.Segmenter with `lang`, plus a pl/en abbreviation guard)
- WHEN a sentence spans inline elements (`<a>`, `<em>`) THEN its `range` starts and ends at the right text-node offsets and `range.toString()` equals its text (whitespace-normalised)
- WHEN a block is nested in another block (`li > p`) THEN its text is counted once
- WHEN a block is empty or whitespace-only, or inside `script/style/noscript/[aria-hidden=true]` THEN it yields no sentence
- WHEN a sentence exceeds 400 chars THEN `pieces` are ≤400 chars, cut at spaces, and join back to the text

**Tests (names only — red first):**
- "splits paragraphs into sentences with paragraph indexes"
- "does not break after Polish abbreviations or inside decimal commas"
- "sentence range covers text across inline elements"
- "nested blocks are counted once"
- "skips empty, hidden and script blocks"
- "cuts long sentences into pieces at spaces"

- [x] **Step 1: Write the failing tests** — Run: `npm test` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `npm test` — Expected: PASS
- [x] **Step 3: Commit** — `git commit -m "feat(extension): sentence and paragraph segmentation"`

### Task 4: Reading sources

**Files:**
- Create: `extension/src/content/source.mjs`
- Test: `extension/src/content/__tests__/source.test.mjs`

**Contract:**
```js
export function articleContainer(doc) // → Element: the original-DOM element matching Readability's result, or doc.body
export function articleSentences(doc, lang) // → Sentence[]; body fallback skips nav, header, footer, aside, [aria-hidden=true]
export function selectionSentences(doc, selection, lang) // → Sentence[] clipped to the selection
export function sentenceIndexAt(sentences, node) // → index of the first sentence of the paragraph containing node, or -1
```

**Acceptance criteria:**
- WHEN the page has an article among nav/aside noise THEN `articleContainer` returns the original element that holds the article text (Readability runs on a clone; the match is found in the live DOM)
- WHEN Readability returns null THEN sentences come from `body` without nav/header/footer/aside/aria-hidden
- WHEN the selection starts mid-sentence THEN the first sentence text starts at the first selected character and the last ends at the last selected character
- WHEN the selection covers two whole sentences THEN exactly two sentences are returned
- WHEN `sentenceIndexAt` gets a node inside paragraph 7 THEN it returns the index of paragraph 7's first sentence; WHEN outside the source THEN -1

**Tests (names only — red first):**
- "articleContainer finds the live article element"
- "falls back to body without chrome elements"
- "selection clips the first and last sentence"
- "selection of two sentences yields two"
- "sentenceIndexAt maps a node to its paragraph start"

- [x] **Step 1: Write the failing tests** — Run: `npm test` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `npm test` — Expected: PASS
- [x] **Step 3: Commit** — `git commit -m "feat(extension): article and selection sources"`

### Task 5: Navigation model

**Files:**
- Create: `extension/src/content/nav.mjs`
- Test: `extension/src/content/__tests__/nav.test.mjs`

**Contract:**
```js
export function next(sentences, i)          // → i+1, or null at the end
export function prev(sentences, i)          // → i-1, or 0 at the start
export function nextParagraph(sentences, i) // → first sentence of the next paragraph, or null
export function prevParagraph(sentences, i) // → start of current paragraph; if i already is it → start of previous paragraph (0 at the first)
```

**Acceptance criteria:**
- WHEN sentence 4 plays and Next THEN 5
- WHEN mid-paragraph 3 and Shift+Previous THEN first sentence of paragraph 3
- WHEN at the first sentence of paragraph 3 and Shift+Previous THEN first sentence of paragraph 2
- WHEN at sentence 0 and Previous THEN 0
- WHEN at the last sentence and Next or Shift+Next THEN null (session ends)

**Tests (names only — red first):**
- "next moves one sentence"
- "prevParagraph goes to the current paragraph start"
- "prevParagraph at a paragraph start goes to the previous one"
- "prev at the first sentence stays at 0"
- "next and nextParagraph at the end return null"

- [x] **Step 1: Write the failing tests** — Run: `npm test` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `npm test` — Expected: PASS
- [x] **Step 3: Commit** — `git commit -m "feat(extension): sentence and paragraph navigation"`

### Task 6: Sentence queue

**Files:**
- Create: `extension/src/offscreen/queue.mjs`
- Test: `extension/src/offscreen/__tests__/queue.test.mjs`

**Contract:**
```js
// fetchAudio(piecesText, voice, signal) → Promise<ArrayBuffer>
export function createQueue({fetchAudio, prefetch = 3})
// → {load(sentences, voice), get(index) → Promise<ArrayBuffer[]>, seek(index), setVoice(voice), clear()}
```

**Acceptance criteria:**
- WHEN `get(i)` is called THEN requests for i…i+3 are in flight or done (each sentence's pieces in order)
- WHEN `seek(20)` from 2 THEN in-flight requests for 3–5 are aborted and 20–23 start
- WHEN `setVoice` THEN all cached and in-flight audio is discarded and refetched with the new voice
- WHEN a fetch fails THEN `get` for that index rejects with the error and other indexes are unaffected
- WHEN `clear` THEN every in-flight request is aborted and the cache is empty

**Tests (names only — red first):**
- "get prefetches the next three sentences"
- "seek aborts requests outside the new window"
- "setVoice discards cached audio"
- "fetch failure rejects only its index"
- "clear aborts everything"

- [x] **Step 1: Write the failing tests** — Run: `npm test` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `npm test` — Expected: PASS
- [x] **Step 3: Commit** — `git commit -m "feat(extension): prefetching sentence queue"`

### Task 7: Offscreen player

**Files:**
- Create: `extension/src/offscreen/player.mjs`
- Modify: `extension/src/offscreen.mjs`, `extension/src/offscreen.html` (move to `src/offscreen/` if cleaner; update manifest/background paths)
- Test: `extension/src/offscreen/__tests__/player.test.mjs`

**Contract:**
```js
// audio: HTMLAudioElement-like; emit(msg) sends `sentence-start` / `state` messages
export function createPlayer({queue, audio, emit, settings})
// → {play({sentences, start, voice, speed}), seek(i), pause(), resume(), stop(), setSpeed(s), setVoice(v)}
```

**Acceptance criteria:**
- WHEN `play` THEN state `loading`, then on first audio `sentence-start {index: start}` and state `playing`
- WHEN a sentence's pieces finish THEN the next sentence plays and `sentence-start` is emitted; after the last THEN state `idle`
- WHEN `setSpeed(1.3)` THEN `audio.playbackRate === 1.3` and `preservesPitch` true, with no new fetch
- WHEN `setVoice` during playback THEN the current sentence restarts in the new voice
- WHEN the queue rejects with an engine error THEN playback stops and state `error` carries the message
- WHEN `stop` THEN audio is paused, the queue cleared, state `idle`
- WHEN object URLs are created for audio THEN each is revoked after its piece ends or on stop

**Tests (names only — red first):**
- "play emits loading then sentence-start and playing"
- "advances through sentences and ends idle"
- "setSpeed changes playbackRate without fetching"
- "setVoice restarts the current sentence"
- "engine error stops with error state"
- "stop clears queue and revokes object urls"

- [x] **Step 1: Write the failing tests** — Run: `npm test` — Expected: FAIL
- [x] **Step 2: Minimal implementation** (wire `offscreen.mjs`: settings from `chrome.storage.sync`, `engine.speak` as `fetchAudio`, messages → player) — Run: `npm test` — Expected: PASS
- [x] **Step 3: Commit** — `git commit -m "feat(extension): offscreen audio player"`

### Task 8: Highlight and player bar

**Files:**
- Create: `extension/src/content/highlight.mjs`, `extension/src/content/bar.mjs`
- Test: `extension/src/content/__tests__/highlight.test.mjs`, `extension/src/content/__tests__/bar.test.mjs`

**Contract:**
```js
export function createHighlighter({highlights = CSS.highlights, Highlight, doc, win}) // → {show(sentence), clear()}
export function createBar({doc, onAction}) // → {setState(state, error?), setVoices(list|null, current), setSpeed(s), destroy()}
// onAction(type, payload): "toggle" | "prev" | "next" | "prev-paragraph" | "next-paragraph" | "speed" | "voice" | "close" | "retry" | "options"
```

**Acceptance criteria:**
- WHEN `show(s)` THEN the `reader-current` highlight holds exactly `s.range` and a `::highlight(reader-current)` style exists once in the document
- WHEN the sentence's rect is outside the viewport THEN `scrollIntoView({block: "center", behavior: "smooth"})` is called; WHEN visible THEN no scroll
- WHEN highlighting THEN the article container's `innerHTML` is unchanged
- WHEN the bar mounts THEN it lives in one host element with a closed shadow root and has buttons play/pause, previous, next, a voice select, a speed control (0.5–2.0 step 0.1) and close
- WHEN Shift is held on previous/next THEN `prev-paragraph` / `next-paragraph` are emitted
- WHEN state is `error` THEN the bar shows the message, an "Open options" link and a Retry button
- WHEN `destroy` THEN the host element is removed

**Tests (names only — red first):**
- "show puts only the current range in the highlight"
- "scrolls only when the sentence is off-screen"
- "highlighting leaves the container DOM unchanged"
- "bar renders all controls in a shadow root"
- "shift on previous and next emits paragraph actions"
- "error state shows message, options link and retry"
- "destroy removes the bar"

- [x] **Step 1: Write the failing tests** — Run: `npm test` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `npm test` — Expected: PASS
- [x] **Step 3: Commit** — `git commit -m "feat(extension): sentence highlight and player bar"`

### Task 9: Content session

**Files:**
- Modify: `extension/src/content/main.mjs`
- Test: `extension/src/content/__tests__/main.test.mjs`

**Acceptance criteria:**
- WHEN `start {source: "auto"}` with no selection THEN `play` is sent with the article sentences from 0 and the bar appears
- WHEN `start {source: "selection"}` (or `auto` with a non-empty selection) THEN `play` is sent with the selection sentences only
- WHEN `start {source: "from-here", x, y}` THEN `play` starts at `sentenceIndexAt` of the element at that point (falls back to 0)
- WHEN the user Alt+clicks a paragraph of the active source THEN `seek` to its first sentence is sent and the click's default action is prevented
- WHEN `sentence-start {index}` arrives THEN the highlighter shows that sentence
- WHEN bar actions arrive THEN they map to `seek` (via `nav.mjs`), `pause`/`resume`, `set-speed`, `set-voice`, `stop`; `next` at the end sends `stop`
- WHEN `toggle` arrives THEN playing ↔ paused
- WHEN close or `stop` THEN highlight cleared, bar destroyed, Alt+click listener removed
- WHEN the script is injected twice into the same page THEN only one session and one bar exist

**Tests (names only — red first):**
- "auto start reads the article from the first sentence"
- "selection start reads only the selection"
- "from-here starts at the paragraph under the point"
- "alt+click seeks to the paragraph start"
- "sentence-start moves the highlight"
- "bar actions map to engine messages"
- "toggle pauses and resumes"
- "stop tears down bar, highlight and listeners"
- "double injection keeps one session"

- [x] **Step 1: Write the failing tests** — Run: `npm test` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `npm run build && npm test` — Expected: PASS
- [x] **Step 3: Commit** — `git commit -m "feat(extension): content reading session"`

### Task 10: Service worker

**Files:**
- Modify: `extension/src/background.mjs`
- Test: `extension/src/__tests__/background.test.mjs`

**Acceptance criteria:**
- WHEN installed THEN context menus "Read selection" (contexts `selection`) and "Read from here" (contexts `page`, `link`, `image`) exist
- WHEN the action is clicked, the `toggle-reading` command fires on a tab with no session, or a menu item is chosen THEN `dist/content.js` is injected via `chrome.scripting.executeScript` and `start` is sent with the matching source
- WHEN `toggle-reading` fires on the tab that owns the session THEN `toggle` is sent instead
- WHEN `play` arrives THEN an offscreen document (`AUDIO_PLAYBACK`) is created if none exists, and the message is forwarded
- WHEN a session plays in tab A and tab B starts reading THEN tab A gets `stop` before B's `play` is forwarded
- WHEN the owning tab closes, reloads or navigates (`tabs.onRemoved`, `tabs.onUpdated` with `status: "loading"`) THEN `stop` goes to offscreen
- WHEN offscreen emits `sentence-start` / `state` THEN they go only to the owning tab

**Tests (names only — red first):**
- "creates both context menus on install"
- "action click injects content and sends start"
- "shortcut toggles an existing session"
- "play creates the offscreen document once"
- "second tab stops the first session"
- "tab reload or close stops playback"
- "offscreen events go to the owning tab only"

- [x] **Step 1: Write the failing tests** — Run: `npm test` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `npm test` — Expected: PASS
- [x] **Step 3: Commit** — `git commit -m "feat(extension): service worker triggers and routing"`

### Task 11: Options page

**Files:**
- Create: `extension/src/settings.mjs` (`DEFAULTS`, `loadSettings(storage)`, `saveSettings(storage, patch)`)
- Modify: `extension/src/options.html`, `extension/src/options.mjs`
- Test: `extension/src/__tests__/settings.test.mjs`, `extension/src/__tests__/options.test.mjs`

**Contract:** `DEFAULTS = {baseUrl: "http://localhost:8892/v1", apiKey: "", voice: "", speed: 1.0, model: "tts-1"}`; storage is `chrome.storage.sync`.

**Acceptance criteria:**
- WHEN nothing is stored THEN `loadSettings` returns `DEFAULTS`
- WHEN the options page opens with the default base URL and the engine lists voices THEN the voice select shows those ids and the stored voice (or the first) is selected
- WHEN `/audio/voices` fails but `/models` succeeds THEN "Connection OK" shows and the voice field is free text
- WHEN both fail THEN the page shows the error and saving still works
- WHEN the user saves a non-localhost base URL THEN `chrome.permissions.request({origins: ["<origin>/*"]})` is called; WHEN denied THEN nothing is saved and a message says why
- WHEN speed is outside 0.5–2.0 THEN it is clamped on save
- WHEN the page bar plays with an empty stored voice THEN the first listed voice is used (content asks `listVoices` once per session)

**Tests (names only — red first):**
- "loadSettings returns defaults"
- "options lists engine voices"
- "options falls back to free-text voice"
- "options shows connection error and still saves"
- "non-local base url requests host permission"
- "denied permission does not save"
- "speed is clamped"

- [x] **Step 1: Write the failing tests** — Run: `npm test` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `npm test` — Expected: PASS
- [x] **Step 3: Commit** — `git commit -m "feat(extension): options page and settings"`

### Task 12: README

**Files:**
- Create: `extension/README.md`
- Modify: `README.md` (new section "Reader extension", after "Narrate / Read Aloud adapter")

**Acceptance criteria:**
- WHEN `extension/README.md` is read THEN it has sections What it is, Requirements, Build and install, Options, Using it, Troubleshooting, Development, with the content listed in design.md § Documentation
- WHEN the top-level README is read THEN its "Reader extension" section has 2–4 lines and links `extension/README.md`
- WHEN commands in the README are run in a fresh clone THEN they work (`npm install`, `npm run build`, `npm test`)

**Verification: non-testable** — Run: `rm -rf node_modules dist && npm install && npm run build && npm test` — Expected: PASS, and every section heading above present (`grep -c '^## ' README.md` ≥ 7)

- [ ] **Step 1: Write both READMEs** — Run: the verification command — Expected: PASS
- [ ] **Step 2: Commit** — `git commit -m "docs(extension): README and top-level link"`

### Task 13: Manual smoke test in Chrome and Edge

**Files:** none (results go to the session progress note)

**Acceptance criteria:**
- WHEN the extension is loaded unpacked in Chrome and in Edge with `./omnivoicectl start` running THEN every checklist item below passes in both, or a failure is recorded with the browser and page
- WHEN an item fails THEN it is fixed in a new commit (with a unit test where the behaviour is testable) and the item re-run

Checklist (one news article in Polish, one English article, one page without an article):
- [ ] Step 1: Options — voices load from `localhost:8892/v1`, "Connection OK"; save voice and speed
- [ ] Step 2: Icon on the Polish article → bar appears, first sentence spoken and highlighted, page scrolls as reading moves
- [ ] Step 3: Next / Previous / Shift+Next / Shift+Previous behave per spec; Alt+click a paragraph lower down jumps there
- [ ] Step 4: Select two sentences → context menu "Read selection" → exactly those two, then the session ends
- [ ] Step 5: "Read from here" on a paragraph starts there
- [ ] Step 6: `Alt+Shift+R` pauses and resumes; speed 1.5 applies immediately; voice change restarts the sentence
- [ ] Step 7: Stop the adapter (`./omnivoicectl stop`) mid-session → bar shows error + Open options + Retry; start it again → Retry continues
- [ ] Step 8: Start reading in a second tab → first tab stops; reload the reading tab → audio stops
- [ ] Step 9: Page without an article → body text read, no nav/footer
- [ ] Step 10: Record the results per browser in the session progress note
