# omnivoice-server glossary

- **Normalisation** — rewriting written-only tokens (digits, symbols, abbreviations) into the words a speaker would say, before synthesis. _Avoid:_ "text cleanup", "stripping".
- **Protected span** — a stretch of text that normalisation must leave byte-for-byte unchanged (bracket tags, URLs, paths, identifiers).
