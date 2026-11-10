## ADDED Requirements

### Requirement: Store package
`pnpm package` builds a store-ready zip containing only runtime files.

#### Scenario: Zip contents
- **WHEN** `pnpm package` runs with version 1.0.0 in `manifest.json` and `package.json`
- **THEN** `lektor-tts-1.0.0.zip` is written with `manifest.json`, `dist/`, `src/` without `__tests__`, and `icons/*.png`, and contains nothing from `node_modules/`, `scripts/`, `store/` or `qa/`

#### Scenario: Version mismatch
- **WHEN** `manifest.json` and `package.json` carry different versions
- **THEN** `pnpm package` exits non-zero and writes no zip

### Requirement: Store screenshots and visual verification
`pnpm screenshots` produces the listing screenshots and the visual-verification captures without a GPU or an API key.

#### Scenario: Screenshots against the fake engine
- **WHEN** `pnpm screenshots` runs
- **THEN** it starts the fake engine and Chromium with the unpacked extension and writes `store/screenshot-reading.png`, `store/screenshot-setup.png` and `store/screenshot-unconfigured.png` at 1280×800, plus `qa/visual/setup-390.png`, `qa/visual/setup-1280.png` and `qa/visual/icon-toolbars.png`

### Requirement: Listing kit
The repo holds everything Greg pastes into Partner Center, with no secret committed.

#### Scenario: Listing text
- **WHEN** `store/listing.md` is read
- **THEN** it contains the name, a short and a full description (with the three engines, OpenAI setup steps, the omnivoice-server Quick start link and a Buy me a coffee line), the category, the support URL, the privacy policy URL, one justification per manifest permission and host pattern, and certification test steps that refer to a key supplied at submission

#### Scenario: Privacy policy
- **WHEN** `PRIVACY.md` is read
- **THEN** it states that no data is collected, page text is sent only to the engine the user configured, settings including the API key stay in browser sync storage, and there is no analytics or remote code

### Requirement: Releasing documentation and footer
The lektor-tts README documents install, setup per preset and the release checklist, and ends with the creator footer.

#### Scenario: Releasing checklist
- **WHEN** the README § Releasing is followed
- **THEN** it lists bump version, `pnpm test`, `pnpm package`, `pnpm screenshots` when the UI changed, upload and paste from `store/listing.md` in Partner Center, then tag `v<version>`

#### Scenario: Footer
- **WHEN** the README ends
- **THEN** it shows "Created by Greg Motyl — github.com/gmotyl" and the yellow Buy Me a Coffee badge linking to `https://buymeacoffee.com/motyl.dev`
