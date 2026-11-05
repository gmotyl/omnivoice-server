# Proposal: text normalisation before synthesis (Polish and English)

## Why

OmniVoice sets the length of the output before it generates it. It estimates the length from the
target text's character count, scaled by the speaking rate of the voice's reference clip
(`_estimate_target_tokens`). Digits, symbols and acronyms are short in writing but long when
spoken: "1,2–1,6 s" is 9 characters but about 50 when spoken. The model therefore gets far too
little time, speaks too fast and swallows words. The user heard it on `krystyna1` and other clones.

Nothing in the chain normalises Polish today:

- The pavilio panel's speech stripper does not touch numbers.
- OmniVoice's own `normalize_text` covers only Chinese and English (WeTextProcessing), plus bare
  integers through `num2words` for every other language. The server calls it with the default
  `False` anyway.
- Edge TTS normalised on its own side, which is why the panel never needed this before.

Measured on `krystyna1` at 16 steps: a 69-character sentence with digits rendered in 6.3 s, while
the same content written out in words (214 characters) rendered in 13.4 s and sounded very good
(user, 2026-11-05). Going from 16 to 32 steps does not change the length (6.33 → 6.44 s).

## What

- A new `normalize.py` module in omnivoice-server rewrites numbers, decimals, ranges, percentages,
  units, amounts of money, dates and abbreviations into their spoken form, for Polish and English. (Acronym spelling was in scope but was removed after the listening check: OmniVoice reads acronyms well by itself.)
- `build_kwargs` applies it once the request's language is resolved, before `model.generate`.
  Other languages, or no language at all, pass through unchanged.
- The env var `OMNIVOICE_NORMALIZE=0` turns it off for A/B listening.
- New dependency: `num2words`.
- Verification: a set of Polish and English test sentences (numbers, dates, amounts, acronyms), rendered
  before and after the change on a listening page.

## Out of scope

- Case agreement of numerals (nominative only; decided 2026-11-05).
- Times of day, phone numbers, Roman numerals.
- Languages other than Polish and English.
- Mixed Polish and English inside one utterance (the request language decides).
- Any change in the pavilio panel or anytts.
