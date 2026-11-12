---
title: Publish Lektor TTS on Edge Add-ons
summary: Split the reader extension into its own public repo gmotyl/lektor-tts, rename it Lektor TTS, give strangers a first-run setup screen (OpenAI, own omnivoice-server, other) and a new icon, and prepare a manual Microsoft Edge Add-ons release.
---

# Change: edge-store-publish

## Why

The reader extension (shipped in `2026-11-09-reader-extension`) only installs unpacked from
`omnivoice-server/extension/` with Developer mode on. Greg wants it on Microsoft Edge Add-ons as a
**public listing**, so that anyone can install it, and so that his own machines (and later mobile
browsers) can install it without Developer mode.

A stranger who installs it today gets a broken first run: nothing opens on install, the default
engine is `http://localhost:8892/v1`, which they don't have, and OpenAI users must type a voice
name by hand because OpenAI has no `/audio/voices`. The name "OmniVoice Reader" also suggests an
official k2-fsa product, which a store review can reject and which is wrong for an extension that
mostly talks to OpenAI.

The extension is also a product of its own (its own users, listing, releases, and soon mobile
targets), so it moves out of the server repo.

## What changes

- **New public repo `gmotyl/lektor-tts`** (MIT), extracted with `git filter-repo` so history is
  kept: the extension at the repo root, plus the `reader-extension` living spec. Added as a second
  repo of the `omnivoice-server` workspace project.
- **Renamed to Lektor TTS** (package `lektor-tts`), version 1.0.0, with a new icon (an "L" with
  sound arcs) rendered from one SVG.
- **Setup screen**: the options page opens on install with three engine presets (OpenAI with a
  fixed voice list per model, default `gpt-4o-mini-tts`; own omnivoice-server; other
  OpenAI-compatible server) and one "Save and test" button. Less common settings fold under
  "More settings".
- **Unconfigured state**: starting a reading session before an engine is set up shows "Set up a
  speech engine" in the player bar instead of an engine error. Existing settings migrate, so
  current installs see no prompt.
- **Release kit**: `pnpm package` (versioned zip), `pnpm screenshots` (Playwright + fake engine,
  store screenshots and visual verification), `store/listing.md` (listing text and permission
  justifications), `PRIVACY.md`, README § Releasing. Upload and submission in Partner Center are
  manual (Greg's todos are in the workspace memo `2026-11-10_1804_lektor_release_manual_todos.md`).
- **Buy me a coffee**: the pavilio-style badge footer in both READMEs, a closing line in the store
  description, and a footer link on the options page.
- **omnivoice-server**: `extension/` and the `reader-extension` living spec are removed; the Quick
  start becomes server-only with step 4 "Install Lektor TTS"; the "Reader extension" section links
  to the new repo.

## Out of scope

- Mobile browsers (Edge for Android, Firefox for Android): the next change.
- Chrome Web Store, Edge Add-ons API automation, CI.
- Narrate and the narrate adapter: unchanged.

## Where the artifacts live

One change id in both repos. Until `lektor-tts` exists, the whole change is written here in
`omnivoice-server`. The split task moves the extension-side parts (`specs/reader-extension`,
`specs/extension-release`, the extension tasks) into `lektor-tts/openspec/changes/2026-11-10-edge-store-publish/`;
`omnivoice-server` keeps this proposal, the design and `specs/server-docs`.
