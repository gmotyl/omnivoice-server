# OmniVoice Reader

## What it is

A Chrome / Edge (Manifest V3) extension that reads the open page aloud through an
OpenAI-compatible text-to-speech server (`POST /audio/speech`) — by default this repository's
Narrate / Read Aloud adapter. It reads in place: the page is never rewritten, the sentence being
spoken is highlighted and scrolled into view, and a small player bar sits on top of the page.

- **Article**: finds the main article (Readability, falling back to `<body>`) and reads it from
  the top.
- **Selection**: reads exactly the selected text; the player stops at the end, the bar stays
  until **Close**, and Alt+click starts reading again.
- **Read from here**: starts at the paragraph you right-clicked. On app pages without an article
  (Slack, Gmail) it reads only the pane you clicked in: the thread, the open conversation.
- **Alt+click**: jumps to any paragraph while reading (or starts again there after reading
  finished, until the bar is closed).
- **Navigation** by sentence, and by paragraph with Shift.
- **Highlight** of the current sentence (CSS Custom Highlight API, no DOM changes).
- **Voice** and **speed** (0.5–2.0) from the bar or the options page.

Polish and English text are segmented into sentences (abbreviations, decimal commas, quotes);
long sentences are cut into pieces of at most 400 characters, and the next sentences are
prefetched while the current one plays.

## Requirements

- Chrome or Edge 116+ (`minimum_chrome_version` in the manifest: the offscreen document API needs
  109+, `chrome.runtime.getContexts` 116+; the CSS Custom Highlight API 105+).
- Node 22+ and pnpm to build.
- An OpenAI-compatible TTS server. The default is our adapter on `http://localhost:8892/v1`,
  started with `./omnivoicectl start` from the repository root (see the top-level
  [README § Narrate / Read Aloud adapter](../README.md#narrate--read-aloud-adapter)).
  `https://api.openai.com/v1` with an API key works too.

## Build and install

```bash
cd extension
pnpm install
pnpm build           # bundles the content script into dist/content.js
```

Then in the browser:

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Turn on **Developer mode**.
3. **Load unpacked** and pick the `extension/` folder (not `dist/`).

After every rebuild, press the reload button on the extension's card; tabs that were already
reading need a page reload too.

## Options

Right-click the toolbar icon → **Options** (or the extension's details page → Extension options).
Settings are stored in `chrome.storage.sync`.

| Setting         | Default                    | Notes                                                                 |
| --------------- | -------------------------- | --------------------------------------------------------------------- |
| Server base URL | `http://localhost:8892/v1` | OpenAI-compatible base; `/audio/speech`, `/audio/voices` and `/models` are appended |
| API key         | empty                      | sent as `Authorization: Bearer …` when set                            |
| Model           | `tts-1`                    | the `model` field of each speech request                              |
| Voice           | empty                      | a list when the server answers `/audio/voices`, else free text; empty = the first listed voice |
| Speed           | `1.0`                      | 0.5 to 2.0, step 0.1                                                  |
| Autoscroll      | on                         | scroll the page to the sentence being read; also toggled on the bar   |

`http://localhost` and `http://127.0.0.1` are allowed by the manifest. Any other base URL
(another host, or `https://`) makes **Save** ask for an optional host permission for that
origin; if you deny it, nothing is saved.

**Test connection** checks the values in the form without saving them. The page shows
"Connection OK" when the server answers, and says so when it is reachable but lists no voices (then
type a voice id).

## Using it

Start reading with any of:

- the **toolbar icon** — reads the selection if there is one, else the article;
- **`Alt+Shift+R`** — the same, or pause / resume when this tab is already reading;
- the **context menu**: **Read selection** (on selected text) or **Read from here** (on the page,
  a link or an image). Chrome reports no click coordinates for context menus, so "Read from here"
  starts at the clicked link or image, otherwise at the element under the pointer. When the
  article found on the page does not hold that point (app pages such as Slack or Gmail, where
  the "article" is the whole app), it reads only the pane around the point: the nearest
  scrolling box or landmark (`main`, `role="main"`, `region`, `dialog`, `complementary`, `feed`,
  `log`) with at least ~200 characters of text, so a Slack thread or the open Gmail conversation
  rather than the channel list.

The player bar:

| Control           | Action                                                        |
| ----------------- | ------------------------------------------------------------- |
| Play / Pause      | pause and resume                                              |
| Previous / Next   | previous / next sentence; with **Shift**: previous / next paragraph |
| Voice             | switch voice; the current sentence starts again in the new voice; remembered as the default |
| Speed slider      | 0.5×–2.0×, applies immediately                                |
| Autoscroll        | on / off: follow the read sentence by scrolling; off keeps the highlight but never scrolls. Saved as the default |
| Close             | stop and remove the bar and highlight                         |

A voice chosen on the bar is saved as the default (the next session and Options use it), and so is
the **Autoscroll** toggle (shared with the Options checkbox). Speed changed on the bar applies to the
current session only; its default lives in Options.
**Alt+click** a paragraph to jump there (also after the last sentence, until you close the bar).
Alt+click outside what is being read (another pane of an app page) starts reading that pane there.
Only one tab reads at a time: starting in another tab stops the first one. Navigating or closing
the reading tab stops it.

To change the shortcut, open `chrome://extensions/shortcuts` (`edge://extensions/shortcuts`).

## Troubleshooting

- **Connection error in the bar**: the server is not reachable or refused the request. The bar
  shows the message with **Retry** and **Open options**. For the default adapter run
  `./omnivoicectl status` (and `./omnivoicectl start`) in the repository root; check the base URL
  and key with **Test connection** in Options.
- **Empty voice list**: the server has no `/audio/voices`; type the voice id in Options. If the
  test says "Connection failed", fix the server first.
- **"Nothing to read on this page"**: no article or text was found. Select the text and use
  **Read selection**, or press **Retry** once the page has finished rendering.
- **Nothing happens on click**: browsers block scripting on `chrome://` / `edge://` pages and the
  Chrome Web Store / Edge Add-ons pages; the extension cannot read there.
- **Resuming after a long pause**: Chrome closes the hidden audio (offscreen) document about 30 s
  after sound stops. The extension recreates it on resume or seek (and on a voice / speed change
  while loading or playing; while paused the change is kept for the next resume), so a pause
  longer than that resumes from the start of the current sentence rather than mid-sentence.
- **The page jumps while I scroll around**: turn **Autoscroll** off on the bar (dimmed = off). The
  current sentence stays highlighted; turning it back on scrolls to it right away.
- **Slack / Gmail reads the sidebar or channel list**: start with **Read from here** (or Alt+click
  while reading) on the message you want; the icon and the shortcut read the whole "article",
  which on app pages is the whole app.
- **Old behaviour after a rebuild**: reload the extension on `chrome://extensions` /
  `edge://extensions`, then reload the page.
- **Shortcut does nothing**: another extension may own `Alt+Shift+R`; check
  `chrome://extensions/shortcuts`.

## Development

```bash
pnpm install
pnpm build           # must run before pnpm test: the manifest test checks dist/content.js
pnpm test            # node --test "src/**/*.test.mjs"
```

Plain ES modules, no framework. `chrome.*`, `fetch`, `Audio` and `CSS.highlights` are injected or
read from `globalThis`, so tests fake them; DOM tests use `linkedom`. Tests live in `__tests__/`
next to the code. `build.mjs` (esbuild) bundles only the content script; everything else is
loaded as-is.

File map:

| Path                         | Role                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `manifest.json`              | MV3 manifest: permissions, command, options page                     |
| `src/background.mjs`         | service worker: triggers, on-demand injection of `dist/content.js`, single-tab ownership, message routing |
| `src/offscreen.html`, `src/offscreen.mjs` | offscreen document: owns the queue and the `<audio>` element |
| `src/offscreen/queue.mjs`    | prefetching sentence queue (3 ahead), abortable                      |
| `src/offscreen/player.mjs`   | plays each sentence's pieces in order, emits progress                |
| `src/engine.mjs`             | OpenAI-compatible client: `speak`, `listVoices`                      |
| `src/settings.mjs`           | defaults, load / save, speed clamp                                   |
| `src/options.html`, `src/options.mjs` | options page                                                |
| `src/content/main.mjs`       | content script entry: picks the source, drives the session, Alt+click |
| `src/content/source.mjs`     | article (Readability), body fallback, pane around a point, selection |
| `src/content/segment.mjs`    | paragraphs → sentences → ≤400-char pieces                            |
| `src/content/nav.mjs`        | sentence / paragraph navigation                                      |
| `src/content/highlight.mjs`  | CSS Custom Highlight of the current sentence, scroll into view       |
| `src/content/bar.mjs`        | player bar (shadow DOM)                                              |

Messages (`chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`). Content scripts talk to the
service worker; the worker re-sends engine commands to the offscreen document stamped
`target: "offscreen"` (offscreen acts only on stamped copies, the worker ignores them):

| type                         | direction                 | payload                                                       |
| ---------------------------- | ------------------------- | ------------------------------------------------------------- |
| `play`                       | content → sw → offscreen  | `{sentences: string[][], start, voice, speed}`; the worker adds `tabId` and `settings: {baseUrl, apiKey, model}` |
| `seek`                       | content → sw → offscreen  | `{index}`                                                     |
| `pause` / `resume` / `stop`  | content or sw → offscreen | —                                                             |
| `set-speed`                  | content → sw → offscreen  | `{speed}`                                                     |
| `set-voice`                  | content → sw → offscreen  | `{voice}`                                                     |
| `sentence-start`             | offscreen → sw → content  | `{index}`                                                     |
| `state`                      | offscreen → sw → content  | `{state: "loading"\|"playing"\|"paused"\|"idle"\|"error", error?}` |
| `stop`                       | sw → content              | — (to the previous owner tab when another tab starts; content tears down without echoing) |
| `toggle`                     | sw → content              | — (shortcut on the reading tab)                               |
| `start`                      | sw → content              | `{source: "auto"\|"selection"\|"from-here", linkUrl?, srcUrl?}` |
| `list-voices`                | content → sw              | — ; answered via `sendResponse` with `{ok, voices: string[] \| null}` (`null`: reachable, no list) or `{ok: false, error}` |
| `open-options`               | content → sw              | — (content scripts cannot open the options page)              |

The spec lives in `openspec/changes/reader-extension/` while the change is open, and in
`openspec/specs/reader-extension/spec.md` after it is archived.
