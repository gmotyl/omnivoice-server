# Proposal: reader-extension — a Chrome/Edge extension that reads pages aloud through an OpenAI-compatible TTS server

## Why

Narrate (Chrome Web Store) reads an article through a self-hosted TTS server, and our `narrate/`
adapter on `localhost:8892` already serves it. But Narrate cannot skip forward or back, and it
cannot read a chosen fragment: it starts at the top and plays to the end. Read Aloud, the other
candidate, gives no way to point its store build at a custom engine and applies daily character
limits (user, 2026-11-09).

We want a reader we control: sentence-level navigation, reading a selection or from a clicked
paragraph, the current sentence highlighted on the page — speaking through any OpenAI-compatible
`/audio/speech` endpoint, by default our adapter at `http://localhost:8892/v1`.

## What

- A new Manifest V3 extension in `extension/` (plain JS ES modules, esbuild bundles the content
  script with Mozilla Readability; tests with `node --test`).
- Reading sources: the page's main article (Readability locates the container; the original DOM is
  read and highlighted in place) and the current text selection.
- Navigation: previous/next sentence, previous/next paragraph (Shift), Alt+click a paragraph to start
  there; the current sentence is highlighted with the CSS Custom Highlight API and scrolled into view.
- Engine: plain OpenAI protocol — one sentence per `POST {baseUrl}/audio/speech`, three sentences
  prefetched, pending requests aborted on skip/stop; speed via `playbackRate`; voices from
  `GET {baseUrl}/audio/voices`, falling back to `GET {baseUrl}/models`.
- UI: a floating player bar (Shadow DOM) at the bottom of the page; an options page for server URL,
  optional API key, default voice and speed; start from the toolbar icon, a keyboard shortcut, or
  the context menu.
- Store-ready shape from day one: `activeTab` + `scripting` instead of `<all_urls>`, localhost-only
  fixed host permissions, other servers requested at runtime, no remote code.
- No server change: the adapter's existing `/v1` surface is enough.

## Distribution

This change ships for daily use in developer mode (Load unpacked) in Chrome and Edge. Publishing is
out of scope and follows as separate changes: Edge Add-ons first, Chrome Web Store later (privacy
policy page, listing assets, store ZIP build).

## Out of scope (later)

- MP3 download of a whole article.
- Reading local `.md` / `.txt` files and PDFs.
- Remembering the reading position per URL.
- Store publishing (see Distribution).
