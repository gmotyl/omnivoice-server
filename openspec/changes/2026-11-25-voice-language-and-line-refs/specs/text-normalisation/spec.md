## ADDED Requirements

### Requirement: Line references are spoken as lines
A capital `L` followed by a line number of two or more digits, or by a range, is spoken as "line"/"lines" in the request's language, with the numbers spelled.

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
In a token made only of letters and digits, every digit run touching a letter is separated from the letters and spelled in the request's language. A single-digit `L<n>` is such a token, not a line reference.

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

## MODIFIED Requirements

### Requirement: Protected spans are untouched
Was: bracket tags, URLs, file paths and identifiers where digits touch letters or underscores pass through byte for byte. Is: bracket tags, URLs, file paths, hex runs of seven or more characters, and identifiers containing an underscore, a dot or an `=` pass through byte for byte. A token of only letters and digits is no longer protected (see "Numbers glued to letters are spoken").

#### Scenario: Identifier with digits
- **WHEN** the input contains `OMNIVOICE_STEPS=16`, `x86_64` or `v1.2.3`
- **THEN** that token is unchanged

#### Scenario: Non-verbal tag
- **WHEN** the input contains `[laughter]`
- **THEN** the tag is unchanged

#### Scenario: File path with a line note
- **WHEN** the input contains `src/app.config.ts`
- **THEN** the path is unchanged
