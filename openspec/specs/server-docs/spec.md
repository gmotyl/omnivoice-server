# server-docs

### Requirement: Extension lives in lektor-tts
omnivoice-server no longer contains the reader extension; it points to the `gmotyl/lektor-tts` repo.

#### Scenario: Repo contents
- **WHEN** the omnivoice-server `master` tree is listed after the change
- **THEN** there is no `extension/` directory and no `openspec/specs/reader-extension/`, while `openspec/changes/archive/2026-11-09-reader-extension/` remains

#### Scenario: Reader extension section
- **WHEN** the README's "Reader extension" section is read
- **THEN** it links to `https://github.com/gmotyl/lektor-tts` and has no build or Load unpacked steps

### Requirement: Server-only Quick start
The Quick start sets up the server and ends by pointing to Lektor TTS.

#### Scenario: Step 4
- **WHEN** a reader follows "Quick start: read web pages aloud"
- **THEN** steps 1–3 cover requirements, install and starting the server, and step 4 is "Install Lektor TTS" with the Edge Add-ons link (once published) and the lektor-tts repo link

#### Scenario: Anchor kept
- **WHEN** the setup screen's Quick start link is opened
- **THEN** `https://github.com/gmotyl/omnivoice-server#quick-start-read-web-pages-aloud` lands on that section

### Requirement: Creator footer
The omnivoice-server README ends with the creator footer.

#### Scenario: Footer
- **WHEN** the README ends
- **THEN** it shows "Created by Greg Motyl — github.com/gmotyl" and the yellow Buy Me a Coffee badge linking to `https://buymeacoffee.com/motyl.dev`

### Requirement: Per-platform setup in the Quick start
The Quick start's requirements and install steps cover Linux/WSL (CUDA) and macOS (CPU) side by side, keeping the existing anchor.

#### Scenario: Linux/WSL block unchanged in substance
- **WHEN** a reader follows the Linux/WSL path of "Quick start: read web pages aloud"
- **THEN** it still asks for an NVIDIA GPU with CUDA, uv, ffmpeg and Node 22+, and installs with `uv sync --frozen` (torch `2.8.0+cu128`)

#### Scenario: macOS block
- **WHEN** a reader follows the macOS path
- **THEN** it lists Apple Silicon on CPU (no MPS), `brew install bash ffmpeg uv node`, the same `uv sync --frozen`, an expected latency of about 7 s per sentence at the CPU default of 8 steps, and that quality is lower than at 16 steps

### Requirement: Env defaults documented per device
The README's "Run" env list documents `OMNIVOICE_DEVICE` (cuda:0 when CUDA is available, else cpu; never mps on its own) and `OMNIVOICE_STEPS` (16 on cuda, 8 on cpu; an explicit value wins).

#### Scenario: Env list
- **WHEN** the README's "Run" env list is read
- **THEN** it states both per-device defaults as above, and the requirements no longer say an NVIDIA GPU is mandatory on every platform
