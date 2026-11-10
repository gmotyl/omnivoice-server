# Lektor TTS on Edge Add-ons Implementation Plan

> **For agentic workers:** implement this plan with [[pavilio-execute-plan]] — task-by-task, top-down; check off each step (`- [ ]` → `- [x]`) as it lands. Do one task fully (test → implement → verify → commit) before starting the next.

**Goal:** Move the reader extension into its own public repo `gmotyl/lektor-tts`, ship it as "Lektor TTS" 1.0.0 with a first-run setup screen, a new icon and a store release kit, and leave `omnivoice-server` server-only.

**Architecture:** `git filter-repo` extracts `extension/` (to the root) plus the reader-extension OpenSpec paths and this change dir into `/srv/git/prv/lektor-tts`. Extension work then happens there on branch `feat/store-release` (PR to `main`); the `omnivoice-server` cleanup happens on `feat/edge-store-publish` (PR to `master`). Presets live in one module that the options page, settings migration and background all read.

**Tech Stack:** MV3 extension (plain ES modules, esbuild for the content bundle), `node --test` + linkedom, pnpm 10, `@resvg/resvg-js`, `fflate`, `playwright`; omnivoice-server: Python 3.12 + uv, pytest, relay `node --test`.

**Design:** [design.md](design.md)

**Repos and paths.** Tasks 1–3 and 15 run in `/srv/git/prv/omnivoice-server`. Tasks 4–14 run in `/srv/git/prv/lektor-tts`, paths relative to its root (old `extension/src/…` is now `src/…`). Task 16 is Greg's. After Task 2 each repo's copy of this file keeps only its own tasks.

---

### Task 1: Extract lektor-tts with history (local only)

**Files:**
- Create: `/srv/git/prv/lektor-tts/` (filtered clone), `LICENSE` (MIT, "Copyright (c) 2026 Greg Motyl"), root `.gitignore` (`node_modules/`, `dist/`, `*.zip`, `qa/visual/`)

**Acceptance criteria:**
- WHEN `git log --oneline` runs in lektor-tts THEN it shows the extension's historical commits (e.g. "alt+click narrows a whole-page session") and none that touched only server files
- WHEN the tree is listed THEN `manifest.json`, `src/`, `build.mjs`, `package.json` sit at the root, and `openspec/specs/reader-extension/`, `openspec/changes/archive/2026-11-09-reader-extension/`, `openspec/changes/2026-11-10-edge-store-publish/` exist; no `server.py`, `relay/`, `narrate/`
- WHEN `corepack pnpm install && corepack pnpm test && corepack pnpm build` run at the root THEN all pass
- WHEN the filter runs THEN it runs on a throwaway `git clone --no-local` of omnivoice-server, never on `/srv/git/prv/omnivoice-server` itself

**Verification: non-testable** — Run: `git -C /srv/git/prv/lektor-tts log --oneline | head; corepack pnpm -C /srv/git/prv/lektor-tts test` — Expected: history present, tests pass. Install the tool with `uv tool install git-filter-repo` if missing. Branch renamed to `main`; no remote yet.

- [x] **Step 1: Filter, rename branch, add LICENSE + .gitignore, verify** — commands per design § Repo split
- [x] **Step 2: Commit** — `git add LICENSE .gitignore && git commit -m "chore: repo bootstrap (MIT, ignores)"`

### Task 2: Split the change artifacts between the repos

**Files:**
- Modify (lektor-tts): `openspec/changes/2026-11-10-edge-store-publish/tasks.md` (keep Tasks 4–14 + header), delete `specs/server-docs/`
- Modify (omnivoice-server): `openspec/changes/2026-11-10-edge-store-publish/tasks.md` (keep Tasks 1–3, 15, 16 + header), delete `specs/reader-extension/`, `specs/extension-release/`
- Both keep `proposal.md` and `design.md` unchanged

**Verification: non-testable** — Run: `ls openspec/changes/2026-11-10-edge-store-publish/specs` in each repo — Expected: lektor-tts `extension-release reader-extension`; omnivoice-server `server-docs`. Each tasks.md keeps the checkboxes already ticked.

- [x] **Step 1: Trim both copies, commit in each** — `git commit -m "docs(openspec): split edge-store-publish between repos"`

### Task 3: Publish the repo (approval gate)

**Files:**
- Modify (workspace): `/srv/git/prv/projects/projects/omnivoice-server/repos.json` (add `{ "name": "lektor-tts", "path": "/srv/git/prv/lektor-tts", "openspec": { "mode": "native" } }`)

**Acceptance criteria:**
- WHEN this task starts THEN the agent stops and asks Greg to approve creating the public GitHub repo `gmotyl/lektor-tts`; nothing is created or pushed without a yes
- WHEN approved THEN `gh repo create gmotyl/lektor-tts --public --description "Read web pages aloud with any OpenAI-compatible text-to-speech engine"` runs, `main` is pushed, and `gh repo view gmotyl/lektor-tts` shows it public with the MIT license detected
- WHEN repos.json is updated THEN it is committed in the workspace repo right away

**Verification: non-testable** — Run: `gh repo view gmotyl/lektor-tts --json visibility,licenseInfo` — Expected: `PUBLIC`, MIT.

- [x] **Step 1: Ask, create, push, update repos.json, commit workspace** — `omnivoice-server: add lektor-tts repo`
- [x] **Step 2: In lektor-tts** — `git switch -c feat/store-release` for Tasks 4–14

### Task 15: omnivoice-server becomes server-only

**Files:**
- Delete: `extension/`, `openspec/specs/reader-extension/`
- Modify: `README.md` (§ "Quick start: read web pages aloud" steps 1–3 server-only, step 4 "Install Lektor TTS"; § "Reader extension" → link section; footer)

**Acceptance criteria:**
- WHEN the tree is listed THEN there is no `extension/` and no `openspec/specs/reader-extension/`, and `openspec/changes/archive/2026-11-09-reader-extension/` remains
- WHEN the Quick start is read THEN its heading (and so the anchor `#quick-start-read-web-pages-aloud`) is unchanged, steps 1–3 cover requirements, install and starting the server, and step 4 "Install Lektor TTS" links `https://github.com/gmotyl/lektor-tts` (the Edge Add-ons link is added in Task 16)
- WHEN § "Reader extension" is read THEN it links to lektor-tts and has no build or Load unpacked steps
- WHEN the README ends THEN it shows the creator line and the yellow badge exactly as in design.md
- WHEN `uv run pytest` and `node --test` in `relay/` run THEN both pass; on SPOCK `./omnivoicectl status` is healthy and `uv run python smoke_test.py` passes

**Verification: non-testable** — Run: `uv run pytest -q && (cd relay && node --test) && ./omnivoicectl status` — Expected: all green.

- [x] **Step 1: Remove, rewrite README, verify, commit** — `git commit -am "chore: move the reader extension to gmotyl/lektor-tts"`
- [ ] **Step 2: Push `feat/edge-store-publish`, open PR to `master`**

### Task 16: Manual smoke and submission (Greg)

**Acceptance criteria:**
- WHEN `lektor-tts-1.0.0.zip` is loaded unpacked in Edge with a fresh profile THEN the setup screen opens on install; OpenAI with a real key reads a page; omnivoice-server on SPOCK reads a page; the result is noted in the progress file
- WHEN Greg submits in Partner Center (memo `2026-11-10_1804_lektor_release_manual_todos.md`) THEN the task is "submitted"; certification is not awaited
- WHEN the store URL exists THEN it is added to the lektor-tts README install section and omnivoice-server Quick start step 4, and lektor-tts is tagged `v1.0.0`

**Verification: non-testable** — Run: `git -C /srv/git/prv/lektor-tts tag -l v1.0.0` — Expected: `v1.0.0` after publication.

- [ ] **Step 1: Smoke in Edge, record results**
- [ ] **Step 2: Greg submits; then add store URL to both READMEs (PRs) and tag `v1.0.0`**
