# Numbers glued to letters are spoken — Implementation Plan

> **For agentic workers:** implement this plan with [[pavilio-execute-plan]] — task-by-task, top-down; check off each step (`- [ ]` → `- [x]`) as it lands. Do one task fully (test → implement → verify → commit) before starting the next.

**Goal:** Line references (`L27–33`) and digits glued to letters (`L5`, `HTML5`) are spoken in the request's language instead of being masked and left to the model.

**Architecture:** A rewrite inside `_mask`'s per-token step runs after the path check and before the identifier check. It turns line references into `line/lines N [to M]` (`linia/linie … do …`) and splits glued letter/digit tokens with spaces. The existing passes (`_units`, `_integers`) then spell the digits.

**Tech Stack:** Python 3.12, `num2words`, pytest.

**Design:** [design.md](design.md)

**Test command** (the clone has no `.venv`, and the primary `.venv` is owned by root):
`PYTHONPATH=. uv run -q --no-project --python '>=3.11' --with num2words --with pytest pytest tests/test_normalize.py -q -p no:cacheprovider --noconftest`

---

### Task 1: Glued numbers are split and spoken

**Files:**
- Modify: `normalize.py` (`_mask`'s inner `token`, `_is_identifier`; new `_is_glued_number`, `_split_glued`)
- Test: `tests/test_normalize.py`

**Acceptance criteria:**
- WHEN `L5` is normalised for en / pl THEN `L five` / `L pięć`
- WHEN `L2 cache` (en) THEN `L two cache`
- WHEN `HTML5`, `mp3`, `4K` (en) THEN `HTML five`, `mp three`, `four K`
- WHEN `7d1a98c` or `deadbeef1` THEN unchanged (hex run ≥ 7 with a digit and a hex letter stays masked)
- WHEN `OMNIVOICE_STEPS=16`, `x86_64`, `v1.2.3`, `report.2026.txt`, `src/app.config.ts` THEN unchanged
- WHEN a glued token carries punctuation (`(HTML5),`) THEN the punctuation is kept and the core is split

**Tests (names only, red first):**
- "glued number keeps the letter and spells the digit (L5 en/pl)"
- "layer name L2 cache is spoken as L two"
- "product and format names are split (HTML5, mp3, 4K)"
- "hex run is not a glued number"
- "underscore, dotted and assignment identifiers stay protected"
- "glued token keeps surrounding punctuation"

- [ ] **Step 1: Write the failing tests.** Run the test command. Expected: FAIL (new cases)
- [ ] **Step 2: Minimal implementation.** Run the test command. Expected: PASS (all 265 existing tests plus the new ones). If an existing test pins the old masking of a letters-and-digits token, update it to the new requirement and say so in the commit.
- [ ] **Step 3: Commit.** `git add normalize.py tests/test_normalize.py && git commit -m "feat(normalize): speak numbers glued to letters"`

### Task 2: Line references are spoken as lines

**Files:**
- Modify: `normalize.py` (new `_LINE_REF` and `_line_reference`, checked before the glued-number rule in `token`)
- Test: `tests/test_normalize.py`

**Contract:** `_LINE_REF = re.compile(r"^L(\d+)(?:[–-]L?(\d+))?$")`. A match with a range, or with ≥ 2 digits, rewrites to `{line|lines} {N}[ {to} {M}]` with words `{"en": ("line", "lines", "to"), "pl": ("linia", "linie", "do")}`. Digits are left for `_integers`. A single digit with no range is not a line reference.

**Acceptance criteria:**
- WHEN `src/app.config.ts · L27–33` (en) THEN `src/app.config.ts · lines twenty-seven to thirty-three`
- WHEN `L27–33` (pl) THEN `linie dwadzieścia siedem do trzydzieści trzy`
- WHEN `L27-33` or `L27–L33` (en) THEN `lines twenty-seven to thirty-three`
- WHEN `see L120.` (en) THEN `see line one hundred and twenty.`; WHEN `L27` (pl) THEN `linia dwadzieścia siedem`
- WHEN `l27` THEN it is not spoken as a line

**Tests (names only, red first):**
- "line range after a path is spoken as lines (en)"
- "line range in Polish uses linie and do"
- "hyphen and second-L ranges are line references"
- "single line with two or more digits (en, pl)"
- "lowercase l is not a line reference"

- [ ] **Step 1: Write the failing tests.** Run the test command. Expected: FAIL
- [ ] **Step 2: Minimal implementation.** Run the test command. Expected: PASS
- [ ] **Step 3: Commit.** `git add normalize.py tests/test_normalize.py && git commit -m "feat(normalize): speak line references as lines"`

### Task 3: Docs and gate

**Files:**
- Modify: `README.md` (the normalisation section: line references and glued numbers, with the still-protected list)
- Modify: `normalize.py` module docstring (protected spans now exclude letters-and-digits tokens)

**Verification (non-testable):** Run the test command. Expected: all pass. Also run `PYTHONPATH=. uv run -q --no-project --python '>=3.11' --with num2words python -c "from normalize import normalize; print(normalize('src/app.config.ts · L27–33 and L5', 'en'))"`. Expected: `src/app.config.ts · lines twenty-seven to thirty-three and L five`.

- [ ] **Step 1: Update the docs; run the verification**
- [ ] **Step 2: Commit, push the branch, open a PR** against `gmotyl/omnivoice-server:master` with the coordinated pavilio change named in the body.
- [ ] **Step 3: Live check (human).** The server runs as root on SPOCK. Greg restarts it after the merge (`./omnivoicectl restart` as root) and plays a story line note with `bill-en`.
