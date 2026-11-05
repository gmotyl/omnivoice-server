import logging
import re

import pytest

import normalize as nm
from normalize import normalize

PROTECTED = [
    "[laughter]",
    "[B EY1 S]",
    "https://a.b/c1",
    "src/a1/b.py",
    "OMNIVOICE_STEPS=16",
    "v1.2.3",
    "x86_64",
    "mp3",
]


def _rewrite_everything(text: str, lang: str) -> str:
    """An aggressive stand-in pass: rewrites every digit, uppercase letter and slash it sees."""
    text = re.sub(r"\d", "#", text)
    text = re.sub(r"[A-Z]", lambda m: m.group().lower(), text)
    return text.replace("/", " slash ").replace("_", " ").replace("=", " equals ")


def test_other_language_unchanged(monkeypatch):
    monkeypatch.setattr(nm, "PASSES", [*nm.PASSES, ("everything", _rewrite_everything)])
    text = "Mam 32 lata, API v1.2.3 i 5.11.2026 r. — ok. 15% NATO."
    for language in ("de", "", None, "fr-FR", 7):
        assert normalize(text, language) == text


def test_locale_reduced_to_base_code(monkeypatch):
    seen: list[str] = []

    def record(text: str, lang: str) -> str:
        seen.append(lang)
        return text

    monkeypatch.setattr(nm, "PASSES", [("record", record)])
    normalize("x", "pl-PL")
    normalize("x", "en_GB")
    normalize("x", "PL")
    assert seen == ["pl", "en", "pl"]


@pytest.mark.parametrize("language", ["pl", "en"])
def test_protected_spans_untouched(monkeypatch, language):
    sentence = (
        "Start [laughter] then [B EY1 S], see https://a.b/c1, open src/a1/b.py; "
        "set OMNIVOICE_STEPS=16 on v1.2.3 (x86_64) and play mp3."
    )
    # With the real passes, whatever they are by now.
    out = normalize(sentence, language)
    for span in PROTECTED:
        assert span in out
    # With a pass that would mangle every digit, capital and separator in an unmasked span.
    monkeypatch.setattr(nm, "PASSES", [*nm.PASSES, ("everything", _rewrite_everything)])
    out = normalize(sentence, language)
    for span in PROTECTED:
        assert span in out
    assert out.startswith("start ")  # the dummy pass did run on the unprotected text


def test_failing_pass_is_skipped_and_logged(monkeypatch, caplog):
    def boom(text: str, lang: str) -> str:
        raise ValueError("odd input")

    def shout(text: str, lang: str) -> str:
        return text.upper()

    monkeypatch.setattr(nm, "PASSES", [("boom", boom), ("shout", shout)])
    with caplog.at_level(logging.WARNING, logger="normalize"):
        assert normalize("hello", "en") == "HELLO"
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "boom" in warnings[0].getMessage()


# --- Task 2: integers, grouped thousands, decimals, ranges ----------------------------------


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "32", "trzydzieści dwa"),
        ("en", "32", "thirty-two"),
        ("pl", "Mam 32 lata.", "Mam trzydzieści dwa lata."),
        ("en", "She has 32.", "She has thirty-two."),
        ("pl", "ma 32.", "ma trzydzieści dwa."),
        ("en", "0 and 7", "zero and seven"),
    ],
)
def test_integers_pl_en(language, text, expected):
    assert normalize(text, language) == expected


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "3 100", "trzy tysiące sto"),
        ("pl", "3 100", "trzy tysiące sto"),
        ("pl", "12 345 678", "dwanaście milionów trzysta czterdzieści pięć tysięcy sześćset siedemdziesiąt osiem"),
        ("en", "3,100", "three thousand, one hundred"),
        ("en", "1,000,000", "one million"),
        # Groups must be exactly three digits: these stay separate numbers.
        ("pl", "3 10", "trzy dziesięć"),
        ("pl", "3 1000", "trzy tysiąc"),
    ],
)
def test_grouped_thousands(language, text, expected):
    assert normalize(text, language) == expected


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "1 234,5", "tysiąc dwieście trzydzieści cztery przecinek pięć"),
        ("pl", "1 234,5", "tysiąc dwieście trzydzieści cztery przecinek pięć"),
        ("en", "1,234.5", "one thousand, two hundred and thirty-four point five"),
    ],
)
def test_grouped_thousands_with_decimal_part(language, text, expected):
    assert normalize(text, language) == expected


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "1,2", "jeden przecinek dwa"),
        ("en", "1.2", "one point two"),
        ("pl", "To 0,6.", "To zero przecinek sześć."),
        ("en", "It is 0.6.", "It is zero point six."),
        # The other language's separator is not a decimal.
        ("en", "1,2", "one,two"),
        ("pl", "1.2", "jeden.dwa"),
    ],
)
def test_decimals_pl_comma_en_point(language, text, expected):
    assert normalize(text, language) == expected


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "1,2–1,6", "jeden przecinek dwa do jeden przecinek sześć"),
        ("pl", "4-5", "cztery do pięć"),
        ("pl", "4–5 dni", "cztery do pięć dni"),
        ("pl", "1 000–2 000", "tysiąc do dwa tysiące"),
        ("en", "0.6–0.85", "zero point six to zero point eight five"),
        ("en", "4-5 days", "four to five days"),
        ("en", "1,000-2,000", "one thousand to two thousand"),
    ],
)
def test_ranges_en_dash_and_tight_hyphen(language, text, expected):
    assert normalize(text, language) == expected


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "4 - 5", "cztery - pięć"),
        ("en", "4 - 5", "four - five"),
        # A three-part hyphen chain is not a range (dates are taken earlier, but stay sane).
        ("pl", "1-2-3", "jeden-dwa-trzy"),
        ("en", "1-2-3", "one-two-three"),
    ],
)
def test_spaced_hyphen_is_not_a_range(language, text, expected):
    out = normalize(text, language)
    assert out == expected
    assert " do " not in out and " to " not in out


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "15%", "piętnaście procent"),
        ("pl", "1,5 %", "jeden przecinek pięć procent"),
        ("pl", "wzrost o 15%.", "wzrost o piętnaście procent."),
        ("en", "15%", "fifteen percent"),
        ("en", "1.5 %", "one point five percent"),
        # A bare percent sign is not touched.
        ("pl", "znak %", "znak %"),
    ],
)
def test_percentages(language, text, expected):
    assert normalize(text, language) == expected


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "5 s", "pięć sekundy"),
        ("pl", "1 s", "jeden sekundy"),
        ("pl", "200 ms", "dwieście milisekundy"),
        ("pl", "3 min", "trzy minuty"),
        ("pl", "2 h", "dwa godziny"),
        ("pl", "4 KB", "cztery kilobajty"),
        ("pl", "16 GB.", "szesnaście gigabajty."),
        ("pl", "512 MB", "pięćset dwanaście megabajty"),
        ("pl", "2 TB", "dwa terabajty"),
        ("pl", "50 Hz", "pięćdziesiąt herce"),
        ("pl", "44 kHz", "czterdzieści cztery kiloherce"),
        ("pl", "8 px", "osiem piksele"),
        ("pl", "1 000 MB", "tysiąc megabajty"),
        ("en", "1 s", "one second"),
        ("en", "5 s", "five seconds"),
        ("en", "1 ms", "one millisecond"),
        ("en", "3 min", "three minutes"),
        ("en", "1 h", "one hour"),
        ("en", "16 GB", "sixteen gigabytes"),
        ("en", "1 KB", "one kilobyte"),
        ("en", "2 TB", "two terabytes"),
        ("en", "50 Hz", "fifty hertz"),
        ("en", "44 kHz", "forty-four kilohertz"),
        ("en", "1 px", "one pixel"),
        ("en", "8 px", "eight pixels"),
        ("en", "1.5 s", "one point five seconds"),
        # Units are case-sensitive: `gb` and `S` are not units.
        ("en", "16 gb", "sixteen gb"),
        # Unspaced units stay masked as identifiers (Task 1 behaviour).
        ("pl", "16GB", "16GB"),
    ],
)
def test_units_after_number(language, text, expected):
    assert normalize(text, language) == expected


@pytest.mark.parametrize(
    ("language", "text"),
    [
        ("pl", "s jak sekunda"),
        ("pl", "litera h i min"),
        ("en", "the s in it's and GB in caps"),
        ("en", "px values"),
    ],
)
def test_unit_letter_without_number_unchanged(language, text):
    # The units pass alone: a bare all-caps `GB` is later spelled by the acronyms pass.
    assert nm._units(text, language) == text
    assert normalize(text, language) == text.replace("GB", "G B")


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "ok. pięć", "około pięć"),
        ("pl", "np. tak", "na przykład tak"),
        ("pl", "tj. tak", "to jest tak"),
        ("pl", "m.in. to", "między innymi to"),
        ("pl", "jabłka, gruszki itd.", "jabłka, gruszki i tak dalej."),
        ("pl", "itd. i tak", "i tak dalej i tak"),
        ("pl", "tzw. bufor", "tak zwany bufor"),
        ("pl", "godz. 5", "godzina pięć"),
        ("pl", "w 2026 r. było", "w dwa tysiące dwadzieścia sześć roku było"),
        ("pl", "To był 2026 r.", "To był dwa tysiące dwadzieścia sześć roku."),
        # A lone `r.` not after a year stays.
        ("pl", "punkt r. dalej", "punkt r. dalej"),
        # Whole tokens only.
        ("pl", "blok. dalej", "blok. dalej"),
        ("en", "e.g. this", "for example this"),
        ("en", "i.e. that", "that is that"),
        ("en", "approx. 5", "approximately five"),
        ("en", "React vs. Vue", "React versus Vue"),
        # Each language uses only its own abbreviations.
        ("en", "ok. np.", "ok. np."),
        ("pl", "e.g. vs.", "e.g. vs."),
    ],
)
def test_abbreviations_pl_en(language, text, expected):
    assert normalize(text, language) == expected


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        (
            "pl",
            "zajmie ok. 1,2–1,6 s",
            "zajmie około jeden przecinek dwa do jeden przecinek sześć sekundy",
        ),
        ("en", "takes 1.2–1.6 s", "takes one point two to one point six seconds"),
    ],
)
def test_swallowed_sentence_2026_11_05(language, text, expected):
    assert normalize(text, language) == expected


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "3,0", "trzy przecinek zero"),
        ("pl", "3,00", "trzy przecinek zero zero"),
        ("en", "2.0", "two point zero"),
        ("en", "0.00", "zero point zero zero"),
        ("en", "1,000.0", "one thousand point zero"),
    ],
)
def test_all_zero_fraction(language, text, expected):
    assert normalize(text, language) == expected


# --- Task 4: dates and money -----------------------------------------------------------------

_PL_DATE = "piąty listopada dwa tysiące dwadzieścia sześć"
_EN_DATE = "November fifth, twenty twenty-six"


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("5.11.2026", _PL_DATE),
        ("05.11.2026", _PL_DATE),
        ("2026-11-05", _PL_DATE),
        ("5 listopada 2026", _PL_DATE),
        ("Dziś jest 05.11.2026.", f"Dziś jest {_PL_DATE}."),
        ("1.01.2027", "pierwszy stycznia dwa tysiące dwadzieścia siedem"),
        ("22 lutego 2026", "dwudziesty drugi lutego dwa tysiące dwadzieścia sześć"),
        # `r.` after the year is read as "roku", with a sentence-ending dot kept.
        ("5 listopada 2026 r. było", f"{_PL_DATE} roku było"),
        ("To było 5.11.2026 r.", f"To było {_PL_DATE} roku."),
        ("2026-11-05 r. tak", f"{_PL_DATE} roku tak"),
    ],
)
def test_dates_pl(text, expected):
    assert normalize(text, "pl") == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("2026-11-05", _EN_DATE),
        ("November 5, 2026", _EN_DATE),
        ("5 November 2026", _EN_DATE),
        ("On 2026-11-05, we met.", f"On {_EN_DATE}, we met."),
        ("January 1, 2027", "January first, twenty twenty-seven"),
        ("22 February 2026.", "February twenty-second, twenty twenty-six."),
    ],
)
def test_dates_en(text, expected):
    assert normalize(text, "en") == expected


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "29.02.2028", "dwudziesty dziewiąty lutego dwa tysiące dwadzieścia osiem"),
        ("pl", "2028-02-29", "dwudziesty dziewiąty lutego dwa tysiące dwadzieścia osiem"),
        ("pl", "29 lutego 2028", "dwudziesty dziewiąty lutego dwa tysiące dwadzieścia osiem"),
        ("en", "2028-02-29", "February twenty-ninth, twenty twenty-eight"),
        ("en", "February 29, 2028", "February twenty-ninth, twenty twenty-eight"),
        ("en", "29 February 2028", "February twenty-ninth, twenty twenty-eight"),
    ],
)
def test_leap_day_is_a_date(language, text, expected):
    assert normalize(text, language) == expected


@pytest.mark.parametrize(
    ("language", "text", "date_word"),
    [
        ("pl", "31.02.2026", "lutego"),
        ("pl", "31.04.2026", "kwietnia"),
        ("pl", "29.02.2026", "lutego"),
        ("pl", "2026-02-30", "lutego"),
        ("pl", "2026-04-31", "kwietnia"),
        ("pl", "31 kwietnia 2026", "trzydziesty pierwszy"),
        ("pl", "29 lutego 2026", "dwudziesty dziewiąty"),
        ("en", "2026-02-29", "February"),
        ("en", "2026-06-31", "June"),
        ("en", "February 30, 2026", "thirtieth"),
        ("en", "31 April 2026", "thirty-first"),
    ],
)
def test_impossible_calendar_date_not_a_date(language, text, date_word):
    out = normalize(text, language)
    assert date_word not in out
    assert not any(ch.isdigit() for ch in out)  # the number passes still read the digits


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "5/11/2026", "pięć/jedenaście/dwa tysiące dwadzieścia sześć"),
        ("en", "5/11/2026", "five/eleven/two thousand and twenty-six"),
    ],
)
def test_slash_date_not_a_date(language, text, expected):
    out = normalize(text, language)
    assert out == expected
    assert "listopada" not in out and "November" not in out and "fifth" not in out


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "12,50 zł", "dwanaście złotych, pięćdziesiąt groszy"),
        ("pl", "12,50 PLN", "dwanaście złotych, pięćdziesiąt groszy"),
        ("pl", "PLN 12,50", "dwanaście złotych, pięćdziesiąt groszy"),
        ("pl", "Kosztuje 12,50 zł.", "Kosztuje dwanaście złotych, pięćdziesiąt groszy."),
        ("pl", "1 zł", "jeden złoty"),
        ("pl", "2 zł", "dwa złote"),
        ("pl", "5 PLN", "pięć złotych"),
        ("pl", "12 zł", "dwanaście złotych"),
        ("pl", "22 zł", "dwadzieścia dwa złote"),
        ("pl", "1 200 zł", "tysiąc dwieście złotych"),
        ("pl", "€1", "jedno euro"),
        ("pl", "1 €", "jedno euro"),
        ("pl", "1,50 EUR", "jedno euro, pięćdziesiąt centów"),
        ("pl", "21 €", "dwadzieścia jeden euro"),
        ("pl", "2 EUR", "dwa euro"),
        ("pl", "2,02 €", "dwa euro, dwa centy"),
        ("pl", "$1", "jeden dolar"),
        ("pl", "2 USD", "dwa dolary"),
        ("pl", "USD 5", "pięć dolarów"),
        ("pl", "12 $", "dwanaście dolarów"),
        ("pl", "22 USD", "dwadzieścia dwa dolary"),
        ("en", "$12.50", "twelve dollars, fifty cents"),
        ("en", "12.50 USD", "twelve dollars, fifty cents"),
        ("en", "USD 12.50", "twelve dollars, fifty cents"),
        ("en", "$1", "one dollar"),
        ("en", "$1.01", "one dollar, one cent"),
        ("en", "2 USD", "two dollars"),
        ("en", "1,200 USD", "one thousand, two hundred dollars"),
        ("en", "€2", "two euro"),
        ("en", "12 EUR", "twelve euro"),
        ("en", "£1", "one pound"),
        ("en", "£3", "three pounds"),
        ("en", "22 GBP", "twenty-two pounds"),
        ("en", "It costs $5.", "It costs five dollars."),
    ],
)
def test_money_num2words_currencies(language, text, expected):
    assert normalize(text, language) == expected


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "$0,99", "dziewięćdziesiąt dziewięć centów"),
        ("pl", "0,50 USD", "pięćdziesiąt centów"),
        ("en", "£0.05", "five pence"),
        ("en", "0.50 GBP", "fifty pence"),
    ],
)
def test_money_zero_major_part_dropped_long_names(language, text, expected):
    out = normalize(text, language)
    assert out == expected
    assert "zero" not in out


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "5 €", "pięć euro"),
        ("pl", "€5", "pięć euro"),
        ("pl", "5,00 €", "pięć euro"),
        ("pl", "5,00 zł", "pięć złotych"),
        ("en", "£3", "three pounds"),
        ("en", "3.00 GBP", "three pounds"),
        ("en", "$5.00", "five dollars"),
        # A zero major part is dropped too.
        ("pl", "0,50 zł", "pięćdziesiąt groszy"),
        ("pl", "0,05 CHF", "pięć centymów"),
        ("en", "0.50 USD", "fifty cents"),
    ],
)
def test_money_zero_minor_part_dropped(language, text, expected):
    out = normalize(text, language)
    assert out == expected
    assert "zero" not in out


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "199 USD", "sto dziewięćdziesiąt dziewięć dolarów"),
        ("pl", "$199", "sto dziewięćdziesiąt dziewięć dolarów"),
        ("en", "199 USD", "one hundred and ninety-nine dollars"),
        ("en", "$199", "one hundred and ninety-nine dollars"),
    ],
)
def test_money_integer_not_cents(language, text, expected):
    out = normalize(text, language)
    assert out == expected
    assert "amerykańsk" not in out


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # CZK: feminine, so "jedna" and "dwie", including inside compounds.
        ("1 Kč", "jedna korona"),
        ("2 Kč", "dwie korony"),
        ("3 Kč", "trzy korony"),
        ("5 CZK", "pięć koron"),
        ("12 Kč", "dwanaście koron"),
        ("21 Kč", "dwadzieścia jeden koron"),
        ("22 Kč", "dwadzieścia dwie korony"),
        ("CZK 22", "dwadzieścia dwie korony"),
        ("1,50 Kč", "jedna korona, pięćdziesiąt halerzy"),
        ("12,22 Kč", "dwanaście koron, dwadzieścia dwa halerze"),
        # CHF.
        ("1 CHF", "jeden frank"),
        ("2 CHF", "dwa franki"),
        ("5 CHF", "pięć franków"),
        ("12 CHF", "dwanaście franków"),
        ("20 CHF", "dwadzieścia franków"),
        ("CHF 22", "dwadzieścia dwa franki"),
        ("2,01 CHF", "dwa franki, jeden centym"),
        ("1,05 CHF", "jeden frank, pięć centymów"),
        # GBP has no Polish num2words forms.
        ("£1", "jeden funt"),
        ("£2", "dwa funty"),
        ("2 £", "dwa funty"),
        ("5 GBP", "pięć funtów"),
        ("£12", "dwanaście funtów"),
        ("GBP 22", "dwadzieścia dwa funty"),
        ("£2,03", "dwa funty, trzy pensy"),
        ("£3,00", "trzy funty"),
    ],
)
def test_money_local_table_plural_rule_pl(text, expected):
    assert normalize(text, "pl") == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("1 CZK", "one koruna"),
        ("2 CZK", "two korunas"),
        ("5 Kč", "five korunas"),
        ("CZK 12", "twelve korunas"),
        ("22 CZK", "twenty-two korunas"),
        ("1.01 CZK", "one koruna, one haler"),
        ("CHF 1", "one franc"),
        ("2 CHF", "two francs"),
        ("20 CHF", "twenty francs"),
        ("1.50 CHF", "one franc, fifty centimes"),
        ("CHF 2.01", "two francs, one centime"),
        ("20.00 CHF", "twenty francs"),
    ],
)
def test_money_local_table_en(text, expected):
    assert normalize(text, "en") == expected


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "10–20 zł", "dziesięć do dwadzieścia złotych"),
        ("pl", "10-20 zł", "dziesięć do dwadzieścia złotych"),
        ("pl", "1–2 zł", "jeden do dwa złote"),
        ("pl", "€10–20", "dziesięć do dwadzieścia euro"),
        ("pl", "10–22 Kč", "dziesięć do dwadzieścia dwie korony"),
        ("pl", "3–5 CHF", "trzy do pięć franków"),
        ("en", "$10–20", "ten to twenty dollars"),
        ("en", "10-20 USD", "ten to twenty dollars"),
        ("en", "£1–2", "one to two pounds"),
        ("en", "1–2 CZK", "one to two korunas"),
    ],
)
def test_money_range(language, text, expected):
    assert normalize(text, language) == expected


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "Np. to", "Na przykład to"),
        ("pl", "M.in. to", "Między innymi to"),
        ("pl", "Ok. 5 osób", "Około pięć osób"),
        ("pl", "Było fajnie. Np. wczoraj.", "Było fajnie. Na przykład wczoraj."),
        ("en", "E.g. this", "For example this"),
        ("en", "I.e. this", "That is this"),
        # `Ok.` as a standalone interjection (a new sentence follows) is not "Około".
        ("pl", "Ok. Zrobię to.", "Ok. Zrobię to."),
    ],
)
def test_capitalised_abbreviations(language, text, expected):
    assert normalize(text, language) == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("API", "a pe i"),
        ("TTS", "te te es"),
        ("PR", "pe er"),
        ("Otwórz PR, potem API.", "Otwórz pe er, potem a pe i."),
        ("(GPU)", "(gie pe u)"),
        ("XYZ", "iks igrek zet"),
    ],
)
def test_acronyms_spelled_pl(text, expected):
    assert normalize(text, "pl") == expected


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("GPU", "G P U"),
        ("Use the API.", "Use the A P I."),
        ("TTS and GPU", "T T S and G P U"),
        # Money consumes a code next to an amount, so the acronym pass never sees it.
        ("12.50 USD", "twelve dollars, fifty cents"),
    ],
)
def test_acronyms_spelled_en(text, expected):
    assert normalize(text, "en") == expected


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "PRs", "pe ery"),
        ("pl", "Dwa PRs.", "Dwa pe ery."),
        ("pl", "APIs", "a pe i"),
        ("pl", "GPUs", "gie pe u"),
        ("pl", "SDKs", "es de ka"),
        ("pl", "VMs", "fau emy"),
        ("en", "PRs", "P Rs"),
        ("en", "APIs", "A P Is"),
    ],
)
def test_acronym_plural_s(language, text, expected):
    assert normalize(text, language) == expected


@pytest.mark.parametrize("language", ["pl", "en"])
@pytest.mark.parametrize("text", ["JSON", "RAM", "NATO", "ASAP", "OK", "OK, NASA i GIFs."])
def test_read_as_word_acronyms_unchanged(language, text):
    assert normalize(text, language) == text


@pytest.mark.parametrize(
    ("language", "text", "expected"),
    [
        ("pl", "XX wiek", "XX wiek"),
        ("pl", "Karol III", "Karol III"),
        ("pl", "Rozdział IV", "Rozdział IV"),
        ("pl", "XXI wiek i XIV rozdział, tom VI.", "XXI wiek i XIV rozdział, tom VI."),
        ("en", "World War II", "World War II"),
        ("en", "Chapter XIV", "Chapter XIV"),
        ("en", "the XXI century", "the XXI century"),
        # Guards: tokens with C, D, L or M, or not a valid numeral, are still spelled.
        ("pl", "CV", "ce fau"),
        ("pl", "CI/CD", "ce i/ce de"),
        ("pl", "MI", "em i"),
        ("pl", "DC", "de ce"),
        ("pl", "IIV", "i i fau"),
        ("en", "CV", "C V"),
        ("en", "CI/CD", "C I/C D"),
    ],
)
def test_roman_numerals_unchanged(language, text, expected):
    assert normalize(text, language) == expected


@pytest.mark.parametrize("language", ["pl", "en"])
@pytest.mark.parametrize(
    "text",
    [
        "OmniVoice",
        "iPhone",
        "A",
        "I am",
        "UNESCO",
        "ABCDEF",
        "APIx",
        "xAPI",
        "API_KEY",
        "OMNIVOICE_STEPS",
        "OMNIVOICE_STEPS=16",
        "MyAPI",
    ],
)
def test_mixed_case_and_single_capital_unchanged(language, text):
    assert normalize(text, language) == text
