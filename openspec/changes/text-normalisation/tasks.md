# Text normalisation Implementation Plan

> **For agentic workers:** implement this plan with [[pavilio-execute-plan]] — task-by-task, top-down; check off each step (`- [ ]` → `- [x]`) as it lands. Do one task fully (test → implement → verify → commit) before starting the next.

**Goal:** Rewrite numbers, dates, money, units, abbreviations and acronyms into spoken Polish or English words before OmniVoice synthesis, so the duration estimate matches what is actually said.

**Architecture:** A pure `normalize.py` module (no FastAPI or model imports) runs ordered regex passes over the text, with protected spans masked first. `server.build_kwargs` calls it once the language is resolved. `OMNIVOICE_NORMALIZE` switches it off.

**Tech Stack:** Python 3, `num2words`, pytest (`.venv/bin/python -m pytest`), uv.

**Design:** [design.md](./design.md)

---

Test command for every task: `.venv/bin/python -m pytest tests/test_normalize.py -q` (Task 6: `tests/test_speech_normalize.py`). Tests live in `tests/` (this repo's existing convention, not `__tests__`).

### Task 1: Dependency and module skeleton with protected spans

**Files:**
- Modify: `pyproject.toml` (`dependencies`), `uv.lock`
- Create: `normalize.py`
- Test: `tests/test_normalize.py`

**Contract:**
```python
def normalize(text: str, language: str) -> str: ...
# language: "pl" | "en" | anything else (returned unchanged); "pl-PL" → "pl"
```

**Acceptance criteria:**
- WHEN `uv add num2words` has run THEN `.venv/bin/python -c "import num2words"` succeeds and `uv.lock` is updated
- WHEN language is `de` or empty THEN the input is returned unchanged
- WHEN the input contains `[laughter]`, `[B EY1 S]`, `https://a.b/c1`, `src/a1/b.py`, `OMNIVOICE_STEPS=16`, `v1.2.3`, `x86_64` or `mp3` THEN those spans come back byte for byte (with all later passes enabled)
- WHEN a pass raises THEN `normalize` skips it, logs a warning naming the pass, and returns the other passes' result

**Tests (names only — red first):**
- "test_other_language_unchanged"
- "test_locale_reduced_to_base_code"
- "test_protected_spans_untouched"
- "test_failing_pass_is_skipped_and_logged"

- [x] **Step 1: Write the failing tests** — Run: test command — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: test command — Expected: PASS
- [x] **Step 3: Commit** — `git add pyproject.toml uv.lock normalize.py tests/test_normalize.py && git commit -m "feat(normalize): module skeleton with protected spans"`

### Task 2: Integers, grouped thousands, decimals, ranges

**Files:**
- Modify: `normalize.py`
- Test: `tests/test_normalize.py`

**Acceptance criteria:**
- WHEN pl `32` THEN `trzydzieści dwa`; WHEN en `32` THEN `thirty-two`
- WHEN pl `3 100` or `3 100` THEN `trzy tysiące sto`; WHEN en `3,100` THEN `three thousand, one hundred` (num2words form)
- WHEN pl `1 234,5` THEN one number (`tysiąc dwieście trzydzieści cztery przecinek pięć`)
- WHEN pl `1,2` THEN `jeden przecinek dwa`; WHEN en `1.2` THEN `one point two`
- WHEN pl `1,2–1,6` or `4-5` THEN `… do …`; WHEN en `0.6–0.85` THEN `… to …`
- WHEN a spaced hyphen `4 - 5` THEN no range word is inserted

**Tests (names only — red first):**
- "test_integers_pl_en"
- "test_grouped_thousands"
- "test_grouped_thousands_with_decimal_part"
- "test_decimals_pl_comma_en_point"
- "test_ranges_en_dash_and_tight_hyphen"
- "test_spaced_hyphen_is_not_a_range"

- [x] **Step 1: Write the failing tests** — Run: test command — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: test command — Expected: PASS
- [x] **Step 3: Commit** — `git commit -am "feat(normalize): numbers, decimals, ranges"`

### Task 3: Percentages, units, abbreviations

**Files:**
- Modify: `normalize.py`
- Test: `tests/test_normalize.py`

**Acceptance criteria:**
- WHEN pl `15%` or `1,5 %` THEN `piętnaście procent` / `jeden przecinek pięć procent`; WHEN en `15%` THEN `fifteen percent`
- WHEN a number is followed by s, ms, min, h, KB, MB, GB, TB, Hz, kHz or px THEN pl uses the fixed plural word (`sekundy`, `gigabajty`, …) and en uses singular for 1, plural otherwise
- WHEN a unit letter stands without a preceding number (`s` in prose) THEN it is unchanged
- WHEN pl `ok.`, `np.`, `tj.`, `m.in.`, `itd.`, `tzw.`, `godz.`, or `r.` after a year THEN the full words from design.md; WHEN en `e.g.`, `i.e.`, `approx.`, `vs.` THEN the full words
- WHEN pl `zajmie ok. 1,2–1,6 s` THEN exactly `zajmie około jeden przecinek dwa do jeden przecinek sześć sekundy`; WHEN en `takes 1.2–1.6 s` THEN exactly `takes one point two to one point six seconds`

**Tests (names only — red first):**
- "test_percentages"
- "test_units_after_number"
- "test_unit_letter_without_number_unchanged"
- "test_abbreviations_pl_en"
- "test_swallowed_sentence_2026_11_05"

- [x] **Step 1: Write the failing tests** — Run: test command — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: test command — Expected: PASS
- [x] **Step 3: Commit** — `git commit -am "feat(normalize): percentages, units, abbreviations"`

### Task 4: Dates and money

**Files:**
- Modify: `normalize.py`
- Test: `tests/test_normalize.py`

**Acceptance criteria:**
- WHEN pl `5.11.2026`, `05.11.2026`, `2026-11-05` or `5 listopada 2026` THEN `piąty listopada dwa tysiące dwadzieścia sześć`
- WHEN en `2026-11-05`, `November 5, 2026` or `5 November 2026` THEN `November fifth, twenty twenty-six`
- WHEN `5/11/2026` THEN it is not read as a date
- WHEN pl `12,50 zł` or `12,50 PLN` THEN `dwanaście złotych, pięćdziesiąt groszy`
- WHEN pl `5 €` or `€5` THEN `pięć euro` (zero minor part dropped)
- WHEN en `$12.50` or `12.50 USD` THEN `twelve dollars, fifty cents`
- WHEN pl `199 USD` THEN `sto dziewięćdziesiąt dziewięć dolarów` (Decimal, not cents; "amerykańskich" dropped)
- WHEN en `£3` THEN `three pounds` (num2words GBP; zero pence dropped)
- WHEN pl `1 Kč`, `3 Kč`, `12 Kč`, `22 Kč` THEN `jedna korona`, `trzy korony`, `dwanaście koron`, `dwadzieścia dwie korony`; WHEN pl `20 CHF` and `£2` THEN local-table forms with the plural rule
- WHEN en `1 CZK` / `20 CHF` THEN singular for 1, plural otherwise
- WHEN pl `10–20 zł` THEN `dziesięć do dwadzieścia złotych`

**Tests (names only — red first):**
- "test_dates_pl"
- "test_dates_en"
- "test_slash_date_not_a_date"
- "test_money_num2words_currencies"
- "test_money_zero_minor_part_dropped"
- "test_money_integer_not_cents"
- "test_money_local_table_plural_rule_pl"
- "test_money_local_table_en"
- "test_money_range"

- [x] **Step 1: Write the failing tests** — Run: test command — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: test command — Expected: PASS
- [x] **Step 3: Commit** — `git commit -am "feat(normalize): dates and money"`

### Task 5: Acronyms

**Files:**
- Modify: `normalize.py`
- Test: `tests/test_normalize.py`

**Acceptance criteria:**
- WHEN pl `API`, `TTS`, `PR` THEN `a pe i`, `te te es`, `pe er`; WHEN en `GPU` THEN `G P U`
- WHEN `PRs` THEN spelled + plural (pl: `pe ery`; en: `P Rs`)
- WHEN `JSON`, `RAM`, `NATO`, `ASAP` (read-as-word map) THEN unchanged
- WHEN `OmniVoice`, `iPhone`, a single capital `A`, or a 6+ letter all-caps token THEN unchanged
- WHEN an acronym sits inside a protected span (`OMNIVOICE_STEPS`) THEN unchanged

**Tests (names only — red first):**
- "test_acronyms_spelled_pl"
- "test_acronyms_spelled_en"
- "test_acronym_plural_s"
- "test_read_as_word_acronyms_unchanged"
- "test_mixed_case_and_single_capital_unchanged"

- [x] **Step 1: Write the failing tests** — Run: test command — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: test command — Expected: PASS
- [x] **Step 3: Commit** — `git commit -am "feat(normalize): acronyms"`

### Task 6: Wire into the server with a switch

**Files:**
- Modify: `server.py` (`build_kwargs`, module docstring Env list)
- Test: `tests/test_speech_normalize.py`

**Contract:** env `OMNIVOICE_NORMALIZE`, default on; `0`, `false`, `off` (case-insensitive) disable it. Read once at import.

**Acceptance criteria:**
- WHEN POST `/v1/audio/speech` with language `pl` and input `1,2 s` THEN the fake model's `generate` receives `jeden przecinek dwa sekundy`
- WHEN the voice's language is `pl` and the request gives none THEN the text is normalised as Polish
- WHEN language `en` THEN English normalisation; WHEN language `de` or voice `auto` with no language THEN the text is unchanged
- WHEN `OMNIVOICE_NORMALIZE=0` THEN `generate` receives `1,2 s`
- WHEN the full suite runs THEN existing tests still pass

**Tests (names only — red first):**
- "test_speech_normalises_polish"
- "test_speech_uses_voice_language"
- "test_speech_normalises_english"
- "test_speech_other_language_unchanged"
- "test_speech_switch_off"

- [x] **Step 1: Write the failing tests** — Run: `.venv/bin/python -m pytest tests/test_speech_normalize.py -q` — Expected: FAIL
- [x] **Step 2: Minimal implementation** — Run: `.venv/bin/python -m pytest -q` — Expected: PASS
- [x] **Step 3: Commit** — `git add server.py tests/test_speech_normalize.py && git commit -m "feat(server): normalise pl/en text before synthesis"`

### Task 7: Verification sentences and listening page

**Files:**
- Create: `audition/normalize_sentences.txt`, `audition/normalize_ab.py`
- Output (workspace repo): `projects/tts-providers/mockups/<date>-omnivoice-normalize-ab.html`

**Verification: non-testable** — Run: `./omnivoicectl restart` then `.venv/bin/python audition/normalize_ab.py` — Expected: every sentence rendered on `krystyna1` (pl) and one English voice, with normalisation off and on (each request at 16 steps), and a listening page showing per render the input, the normalised text and the audio length. Normalised renders are longer than the raw ones for every sentence that contains digits, dates, amounts or acronyms.

- `normalize_sentences.txt`: at least 6 PL and 6 EN sentences covering integers, decimals, ranges, percentages, units, dates, money in both symbol positions, abbreviations, acronyms (spelled and read-as-word) and one protected identifier; it includes the 2026-11-05 swallowed sentence.
- `normalize_ab.py` renders the baseline against a server started with `OMNIVOICE_NORMALIZE=0`, then restarts it with the default and renders the normalised run. The switch is read once at import, so it cannot be flipped per request. The script records the normalised text by calling `normalize.normalize` directly.

- [x] **Step 1:** write the sentences and the script; run it — Expected: page written, lengths as above
- [x] **Step 2:** user listens and confirms — Expected: no swallowed words
  - 2026-11-05 Greg: no swallowed words caused by normalisation. "adres" + URL misread in both versions (protected span; the panel strips links anyway) → follow-up. Spelled acronyms ("a pe i") were worse than the model's own reading → Task 5 pass removed in 932778b.
- [x] **Step 3: Commit** — omnivoice-server: `git add audition/normalize_sentences.txt audition/normalize_ab.py && git commit -m "test(audition): normalisation A/B sentences"`; workspace repo: commit the mockup on `main`

### Task 8: README

**Files:**
- Modify: `README.md` (env list, a short "Text normalisation" section)

**Verification: non-testable** — Run: `grep -n "OMNIVOICE_NORMALIZE" README.md server.py` — Expected: documented in both, with the pl/en scope and the off switch.

- [x] **Step 1:** update README
- [x] **Step 2: Commit** — `git commit -am "docs: text normalisation"`
