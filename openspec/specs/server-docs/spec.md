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
