---
title: Numbers glued to letters are spoken
summary: Digits stuck to letters, such as the line note L27–33 in a code story, are masked as identifiers and left for the model, which reads them in whichever language it guesses, often Polish under an English voice. Spell them in the request's language and say line references as lines.
---
# Change: Numbers glued to letters are spoken

## Why

The normaliser spells every free-standing number in the request's language. A digit that touches a
letter is different: `_is_identifier` masks the whole token (`L27–33`, `L5`, `HTML5`, `mp3`) and the
model reads the raw digits itself. The model guesses the language from the voice's reference clip, and
the `-en` twins were cloned from bilingual PL+EN clips, so `bill-en` reads the line note
`src/app.config.ts · L27–33` of a pr-explain code story in Polish. The text around it is in English.

## What changes

- A **line reference** (`L27–33`, `L27-33`, `L27–L33`, or `L27` with two or more digits) is said as
  "lines twenty-seven to thirty-three" / "line twenty-seven" (Polish: "linie … do …" / "linia …").
- Any other **glued number** in a token of only letters and digits (`L5`, `HTML5`, `mp3`, `4K`,
  `60s`) is split from its letters, and the later passes say it in the request's language: "L five",
  "HTML five", "four K".
- Code-shaped tokens stay protected: anything with `_`, `.`, `=`, `/`, a hex run of seven or more
  characters, URLs, paths and bracket tags.

The coordinated pavilio change with the same id makes the panel's language follow the selected voice.
Here, the language is the request's (for the `-en`/`-pl` twins, the locked voice language).

## Impact

- `normalize.py` masking step; `tests/test_normalize.py`.
- Living spec `text-normalisation`: requirement "Protected spans are untouched" narrows, and two
  requirements are added.
