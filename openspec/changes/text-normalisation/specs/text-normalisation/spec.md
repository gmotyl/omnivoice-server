# Delta: text-normalisation

## ADDED Requirements

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

### Requirement: Acronyms are spelled by letter
An all-caps token of 2–5 letters is spelled with the language's letter names, unless it is in the read-as-word map.

#### Scenario: Polish acronym
- **WHEN** language `pl` and the input contains `API`
- **THEN** it becomes `a pe i`

#### Scenario: English acronym
- **WHEN** language `en` and the input contains `GPU`
- **THEN** it becomes `G P U`

#### Scenario: Read-as-word acronym
- **WHEN** the input contains `JSON`
- **THEN** it is left as `JSON`

#### Scenario: Mixed-case word
- **WHEN** the input contains `OmniVoice`
- **THEN** it is left unchanged

### Requirement: Protected spans are untouched
Bracket tags, URLs, file paths and identifiers where digits touch letters or underscores pass through byte for byte.

#### Scenario: Identifier with digits
- **WHEN** the input contains `OMNIVOICE_STEPS=16` or `v1.2.3`
- **THEN** that token is unchanged

#### Scenario: Non-verbal tag
- **WHEN** the input contains `[laughter]`
- **THEN** the tag is unchanged

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
