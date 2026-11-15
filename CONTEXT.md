# omnivoice-server glossary

- **Normalisation** — rewriting written-only tokens (digits, symbols, abbreviations) into the words a speaker would say, before synthesis. _Avoid:_ "text cleanup", "stripping".
- **Protected span** — a stretch of text that normalisation must leave byte-for-byte unchanged (bracket tags, URLs, paths, identifiers).
- **Reading session** — one run of reading in one tab, from start to stop, over a fixed list of sentences. _Avoid:_ "playback" for the whole run.
- **Sentence** — the unit of synthesis, navigation and highlighting; one `/audio/speech` request each (long ones split into ≤400-char pieces).
- **Paragraph** — a block element of the reading source; Shift+previous/next jumps between paragraph starts.
- **Reading source** — what a session reads: the article container, the selection, or the clicked pane on an app page.
- **Article container** — the live DOM element matching Readability's main content; read in place, never replaced.
- **Pane** — on an app page, the nearest scroll container or landmark region around the clicked element; the reading source for "Read from here" and Alt+click there.
- **Player bar** — the floating control strip the extension injects at the bottom of the page, in a closed shadow root.
- **Engine** — any server speaking the OpenAI `/audio/speech` protocol at the configured base URL.
- **Primary host** — SPOCK (Windows + WSL2, NVIDIA GPU, CUDA 12.8), the machine every change must keep working first. _Avoid:_ "main machine", "GPU box".
- **Hard gate** — the SPOCK non-regression checks that must pass with the same results before and after a change. _Avoid:_ "smoke check", "sanity test".
- **Device default** — the device the server picks when `OMNIVOICE_DEVICE` is unset: `cuda:0` when CUDA is available, else `cpu`. _Avoid:_ "auto device", "profile".
- **Step default** — the `num_step` the server uses when `OMNIVOICE_STEPS` is unset: 16 on cuda, 8 on cpu. _Avoid:_ "quality profile".
