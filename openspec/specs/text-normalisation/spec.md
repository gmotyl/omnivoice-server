# text-normalisation

### Requirement: Normalise Polish and English text before synthesis
The server rewrites written-only tokens into spoken words when the resolved language is `pl` or `en`.

#### Scenario: Polish decimal range with a unit
- **WHEN** a request with language `pl` has the input `zajmie ok. 1,2–1,6 s`
- **THEN** the model receives `zajmie około jeden przecinek dwa do jeden przecinek sześć sekundy`

#### Scenario: English decimal range with a unit
- **WHEN** a request with language `en` has the input `takes 1.2–1.6 s`
- **THEN** the model receives `takes one point two to one point six seconds`

#### Scenario: Language comes from the voice
- **WHEN** a request names a voice whose language is `pl` and gives no language
- **THEN** the text is normalised as Polish

#### Scenario: Other language
- **WHEN** the resolved language is neither `pl` nor `en`, or there is none
- **THEN** the model receives the input unchanged

### Requirement: Dates are spoken
Polish numeric and ISO dates, and English ISO and month-name dates, become spoken dates.

#### Scenario: Polish numeric date
- **WHEN** language `pl` and the input contains `5.11.2026`
- **THEN** it becomes `piąty listopada dwa tysiące dwadzieścia sześć`

#### Scenario: ISO date in English
- **WHEN** language `en` and the input contains `2026-11-05`
- **THEN** it becomes `November fifth, twenty twenty-six`

#### Scenario: Ambiguous slash date
- **WHEN** the input contains `5/11/2026`
- **THEN** it is not read as a date

### Requirement: Amounts of money are spoken
An amount with a currency symbol or code (PLN/zł, EUR/€, USD/$, GBP/£, CHF, CZK/Kč), before or after the number, becomes a spoken amount with the currency declined.

#### Scenario: Polish złoty with grosze
- **WHEN** language `pl` and the input contains `12,50 zł`
- **THEN** it becomes `dwanaście złotych, pięćdziesiąt groszy`

#### Scenario: Whole amount drops the zero minor part
- **WHEN** language `pl` and the input contains `5 €`
- **THEN** it becomes `pięć euro`

#### Scenario: English dollars, symbol first
- **WHEN** language `en` and the input contains `$12.50`
- **THEN** it becomes `twelve dollars, fifty cents`

#### Scenario: Integer amount is not read as cents
- **WHEN** language `pl` and the input contains `199 USD`
- **THEN** it becomes `sto dziewięćdziesiąt dziewięć dolarów`

#### Scenario: Czech crowns use the Polish plural rule
- **WHEN** language `pl` and the input contains `1 Kč`, `3 Kč`, `12 Kč` or `22 Kč`
- **THEN** they become `jedna korona`, `trzy korony`, `dwanaście koron` and `dwadzieścia dwie korony`

#### Scenario: Range of amounts
- **WHEN** language `pl` and the input contains `10–20 zł`
- **THEN** it becomes `dziesięć do dwadzieścia złotych`, with the currency named once

### Requirement: Acronyms are left to the model
An all-caps token is passed to the model unchanged; OmniVoice pronounces acronyms correctly by itself.

#### Scenario: Polish acronym
- **WHEN** language `pl` and the input contains `API`
- **THEN** it is left as `API`

#### Scenario: English acronym
- **WHEN** language `en` and the input contains `GPU`
- **THEN** it is left as `GPU`

#### Scenario: Mixed-case word
- **WHEN** the input contains `OmniVoice`
- **THEN** it is left unchanged

### Requirement: Protected spans are untouched
Bracket tags, URLs, file paths as `_is_path` recognises them, hex runs of seven or more characters, `KEY=value` assignments, tokens with a non-ASCII digit next to a letter, and identifiers where a digit touches a letter or `_` and the token also contains `_`, `.` or another non-alphanumeric character (`x86_64`, `v1.2.3`) pass through byte for byte. A token of only letters and ASCII `0-9` digits is not protected (see "Numbers glued to letters are spoken").

#### Scenario: Identifier with digits
- **WHEN** the input contains `OMNIVOICE_STEPS=16`, `x86_64` or `v1.2.3`
- **THEN** that token is unchanged

#### Scenario: Non-verbal tag
- **WHEN** the input contains `[laughter]`
- **THEN** the tag is unchanged

#### Scenario: File path with a line note
- **WHEN** the input contains `src/app.config.ts`
- **THEN** the path is unchanged

### Requirement: Line references are spoken as lines
A capital `L` followed by a line number of two or more ASCII `0-9` digits, or by a range of ASCII `0-9` digits, is spoken as "line"/"lines" in the request's language, with the numbers spelled.

#### Scenario: Line range in English
- **WHEN** the input `src/app.config.ts · L27–33` is normalised for `en`
- **THEN** the output is `src/app.config.ts · lines twenty-seven to thirty-three`

#### Scenario: Line range in Polish
- **WHEN** the input `L27–33` is normalised for `pl`
- **THEN** the output is `linie dwadzieścia siedem do trzydzieści trzy`

#### Scenario: Range written with a hyphen or a second L
- **WHEN** the input is `L27-33` or `L27–L33`, normalised for `en`
- **THEN** each becomes `lines twenty-seven to thirty-three`

#### Scenario: Single line with two or more digits
- **WHEN** the input `see L120.` is normalised for `en`, and `L27` for `pl`
- **THEN** the outputs are `see line one hundred and twenty.` and `linia dwadzieścia siedem`

#### Scenario: Lowercase l is not a line reference
- **WHEN** the input contains `l27`
- **THEN** it is not spoken as a line

### Requirement: Numbers glued to letters are spoken
In a token made only of letters and ASCII `0-9` digits, every digit run touching a letter is separated from the letters and spelled in the request's language. A single-digit `L<n>` is such a token, not a line reference. Other scripts' digits do not count: a token holding them is neither a glued number nor a line reference.

#### Scenario: Single-digit L keeps the letter
- **WHEN** the input `L5` is normalised for `en`, and for `pl`
- **THEN** the outputs are `L five` and `L pięć`

#### Scenario: Layer names are not lines
- **WHEN** the input `L2 cache` is normalised for `en`
- **THEN** the output is `L two cache`

#### Scenario: Product and format names
- **WHEN** the inputs `HTML5`, `mp3` and `4K` are normalised for `en`
- **THEN** the outputs are `HTML five`, `mp three` and `four K`

#### Scenario: A hash is not a glued number
- **WHEN** the input contains `7d1a98c` or `deadbeef1`
- **THEN** that token is unchanged

#### Scenario: Non-ASCII digits are not glued numbers or line references
- **WHEN** the input contains `HTML５` or `L２７` (non-ASCII digits)
- **THEN** that token is unchanged

### Requirement: Normalisation can be switched off
The env var `OMNIVOICE_NORMALIZE` set to `0`, `false` or `off` disables normalisation.

#### Scenario: Switched off
- **WHEN** the server starts with `OMNIVOICE_NORMALIZE=0` and a `pl` request contains `1,2 s`
- **THEN** the model receives `1,2 s`

### Requirement: Normalisation never fails a request
A pass that raises is skipped and logged, and synthesis continues.

#### Scenario: A pass throws
- **WHEN** one normalisation pass raises on an input
- **THEN** the request still returns audio, the other passes still apply, and a warning names the pass
