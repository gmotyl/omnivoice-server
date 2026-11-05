"""Text normalisation for Polish and English: written-only tokens become spoken words.

`normalize(text, language)` masks protected spans (OmniVoice bracket tags, URLs, file paths,
identifiers), runs the ordered list of named passes in `PASSES`, and restores the masked spans
byte for byte. It never raises: a pass that throws is skipped and logged.

See openspec/changes/text-normalisation/design.md § Rewrite order for the pass order.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from decimal import Decimal

from num2words import num2words

log = logging.getLogger("normalize")

SUPPORTED_LANGUAGES = ("pl", "en")

Pass = Callable[[str, str], str]

# Ordered (name, function(text, lang) -> text) passes, run after masking, in the order of
# design.md § Rewrite order: dates, money, ranges, percentages, units, grouped thousands,
# decimals, integers, abbreviations, acronyms.
PASSES: list[tuple[str, Pass]] = []  # filled in below the pass definitions

# Language-specific data, filled in by the passes that use it.
ABBREVIATIONS: dict[str, dict[str, str]] = {"pl": {}, "en": {}}
READ_AS_WORD_ACRONYMS: dict[str, frozenset[str]] = {"pl": frozenset(), "en": frozenset()}


# --- Protected spans -----------------------------------------------------------------------

# A placeholder is built from Private Use Area characters only: no digits, no ASCII letters, no
# punctuation and nothing that `\w` matches, so no later pass can match inside or across it.
_PH_OPEN = ""
_PH_CLOSE = ""
_PH_DIGIT0 = 0xE100  # 256 index "digits": U+E100..U+E1FF
_PH_RE = re.compile(f"{_PH_OPEN}[-]+{_PH_CLOSE}")

_BRACKET_TAG = re.compile(r"\[[^\[\]\n]*\]")
_URL = re.compile(r"(?:\b[a-zA-Z][a-zA-Z0-9+.-]*://|\bwww\.)\S+?(?=[.,;:!?)\]\"']*(?:\s|$))")
_TOKEN = re.compile(r"\S+")
_LEADING_PUNCT = "([{\"'«„“"
_TRAILING_PUNCT = ".,;:!?)]}\"'»”"
# A file path: optional root (/, ./, ../, ~/), then segments joined by slashes.
_PATH = re.compile(r"(?:~|\.{1,2})?/?[\w.-]+(?:/[\w.-]+)+/?")
_FILE_EXT = re.compile(r"\.[A-Za-z][A-Za-z0-9]{0,5}$")
# Digits touching a letter or an underscore (mp3, x86_64, v1.2.3), or a KEY=value assignment.
_LETTER = r"(?:[^\W\d]|_)"
_DIGIT_TOUCHES_LETTER = re.compile(rf"{_LETTER}\d|\d{_LETTER}")
_ASSIGNMENT = re.compile(r"^[^\W\d]\w*=\S+$")


def _placeholder(index: int) -> str:
    digits = []
    while True:
        index, d = divmod(index, 256)
        digits.append(chr(_PH_DIGIT0 + d))
        if index == 0:
            break
    return _PH_OPEN + "".join(reversed(digits)) + _PH_CLOSE


def _is_path(core: str) -> bool:
    if not _PATH.fullmatch(core) or not re.search(r"[^\W\d_]", core):
        return False
    rooted = core.startswith(("/", "./", "../", "~/"))
    return rooted or core.count("/") >= 2 or bool(_FILE_EXT.search(core))


def _is_identifier(core: str) -> bool:
    return bool(_DIGIT_TOUCHES_LETTER.search(core) or _ASSIGNMENT.match(core))


def _mask(text: str) -> tuple[str, list[str]]:
    """Replace protected spans with placeholders; return the masked text and the originals."""
    spans: list[str] = []

    def keep(span: str) -> str:
        spans.append(span)
        return _placeholder(len(spans) - 1)

    text = _BRACKET_TAG.sub(lambda m: keep(m.group()), text)
    text = _URL.sub(lambda m: keep(m.group()), text)

    def token(m: re.Match[str]) -> str:
        tok = m.group()
        core = tok.lstrip(_LEADING_PUNCT)
        lead = tok[: len(tok) - len(core)]
        stripped = core.rstrip(_TRAILING_PUNCT)
        trail = core[len(stripped) :]
        if stripped and (_is_path(stripped) or _is_identifier(stripped)):
            return lead + keep(stripped) + trail
        return tok

    text = _TOKEN.sub(token, text)
    return text, spans


def _unmask(text: str, spans: list[str]) -> str:
    def restore(m: re.Match[str]) -> str:
        index = 0
        for ch in m.group()[1:-1]:
            index = index * 256 + (ord(ch) - _PH_DIGIT0)
        return spans[index] if index < len(spans) else m.group()

    # A span masked later may enclose an earlier placeholder, so repeat until none are left.
    for _ in range(len(spans) + 1):
        restored = _PH_RE.sub(restore, text)
        if restored == text:
            break
        text = restored
    return text


# --- Numbers ---------------------------------------------------------------------------------

# ASCII digits only: `\d` would also match other scripts' digits.
_D = "[0-9]"
# The separators of a pl grouped number: space, no-break space, narrow no-break space.
_PL_GROUP_SEP = "[ \u00a0\u202f]"
_DASHES = "-\u2013"  # hyphen-minus, en dash

# A number as written in each language, before grouped thousands and decimals are rewritten.
_RANGE_NUMBER = {
    "pl": rf"{_D}+(?:,{_D}+)?",
    "en": rf"{_D}{{1,3}}(?:,{_D}{{3}})+(?:\.{_D}+)?|{_D}+(?:\.{_D}+)?",
}
# Not inside a word, not continuing a number or a hyphen chain on either side.
_NUM_START = rf"(?<![\w.,{_DASHES}])"
_NUM_END = rf"(?!\w|[.,{_DASHES}]{_D})"

_RANGE = {
    lang: re.compile(rf"{_NUM_START}({num})[{_DASHES}]({num}){_NUM_END}")
    for lang, num in _RANGE_NUMBER.items()
}
_RANGE_WORD = {"pl": "do", "en": "to"}

# Groups of exactly three digits after the leading one to three digits.
_GROUPED = {
    "pl": re.compile(rf"(?<![0-9,.]){_D}{{1,3}}(?:{_PL_GROUP_SEP}{_D}{{3}})+(?!{_D})"),
    "en": re.compile(rf"(?<![0-9,.]){_D}{{1,3}}(?:,{_D}{{3}})+(?!{_D}|,{_D})"),
}
_GROUP_SEP_RE = {"pl": re.compile(_PL_GROUP_SEP), "en": re.compile(",")}

# A decimal needs digits on both sides, so a sentence-final dot (`ma 32.`) stays punctuation.
_DECIMAL = {
    "pl": re.compile(rf"(?<![0-9,.])({_D}+),({_D}+)(?!{_D}|[.,]{_D})"),
    "en": re.compile(rf"(?<![0-9,.])({_D}+)\.({_D}+)(?!{_D}|[.,]{_D})"),
}
_INTEGER = re.compile(rf"{_D}+")


def _ranges(text: str, lang: str) -> str:
    """`4-5`, `1,2–1,6` → `4 do 5`; the numbers are read by the later passes."""
    word = _RANGE_WORD[lang]
    return _RANGE[lang].sub(lambda m: f"{m.group(1)} {word} {m.group(2)}", text)


# --- Percentages, units, years ---------------------------------------------------------------

# Spaces allowed between a number and its `%` sign or unit.
_SPACE = "[ \u00a0\u202f]"
_PERCENT = {
    lang: re.compile(rf"{_NUM_START}({num}){_SPACE}?%") for lang, num in _RANGE_NUMBER.items()
}
_PERCENT_WORD = {"pl": "procent", "en": "percent"}

# unit -> pl fixed plural, en singular, en plural.
_UNITS: dict[str, tuple[str, str, str]] = {
    "s": ("sekundy", "second", "seconds"),
    "ms": ("milisekundy", "millisecond", "milliseconds"),
    "min": ("minuty", "minute", "minutes"),
    "h": ("godziny", "hour", "hours"),
    "KB": ("kilobajty", "kilobyte", "kilobytes"),
    "MB": ("megabajty", "megabyte", "megabytes"),
    "GB": ("gigabajty", "gigabyte", "gigabytes"),
    "TB": ("terabajty", "terabyte", "terabytes"),
    "Hz": ("herce", "hertz", "hertz"),
    "kHz": ("kiloherce", "kilohertz", "kilohertz"),
    "px": ("piksele", "pixel", "pixels"),
}
# Longest first so `ms` / `kHz` win over `s` / `Hz`; the unit is a whole, case-sensitive token.
_UNIT_ALT = "|".join(sorted(map(re.escape, _UNITS), key=len, reverse=True))
_UNIT = {
    lang: re.compile(rf"{_NUM_START}({num})({_SPACE}+)({_UNIT_ALT})(?!\w)")
    for lang, num in _RANGE_NUMBER.items()
}

# `2026 r.` → `2026 roku`; only after a four-digit year, so a lone `r.` stays.
_YEAR_R = re.compile(rf"(?<![\w.,])({_D}{{4}}){_SPACE}+r\.(?!\w)")


def _percentages(text: str, lang: str) -> str:
    """`15%`, `1,5 %` → `15 procent`; the number is read by the later passes."""
    word = _PERCENT_WORD[lang]
    return _PERCENT[lang].sub(lambda m: f"{m.group(1)} {word}", text)


def _units(text: str, lang: str) -> str:
    """`5 s` → `5 sekundy` / `5 seconds`; en uses the singular only for exactly 1."""

    def unit(m: re.Match[str]) -> str:
        pl, en_one, en_many = _UNITS[m.group(3)]
        if lang == "pl":
            word = pl
        else:
            word = en_one if m.group(1) == "1" else en_many
        return f"{m.group(1)}{m.group(2)}{word}"

    return _UNIT[lang].sub(unit, text)


def _year_suffix(text: str, lang: str) -> str:
    """pl `2026 r.` → `2026 roku` (with a sentence-ending dot kept); the year is read later."""
    if lang != "pl":
        return text
    return _YEAR_R.sub(lambda m: m.group(1) + " " + _abbreviation_word(m, "roku", True), text)


def _ends_sentence(text: str, end: int, capital_next: bool) -> bool:
    """True when the abbreviation's dot is also the sentence's full stop."""
    rest = text[end:]
    if re.match(r"[ \t]*(?:\n|$)", rest):
        return True
    return capital_next and bool(re.match(r"\s+[A-ZĄĆĘŁŃÓŚŹŻ]", rest))


def _abbreviation_word(m: re.Match[str], word: str, capital_next: bool) -> str:
    return word + ("." if _ends_sentence(m.string, m.end(), capital_next) else "")


def _grouped_thousands(text: str, lang: str) -> str:
    """`3 100` (pl), `3,100` (en) → `3100`; a decimal part after it is left for the next pass."""
    sep = _GROUP_SEP_RE[lang]
    return _GROUPED[lang].sub(lambda m: sep.sub("", m.group()), text)


_DECIMAL_WORD = {"pl": "przecinek", "en": "point"}
_ZERO_WORD = {"pl": "zero", "en": "zero"}


def _decimals(text: str, lang: str) -> str:
    """`1,2` (pl), `1.2` (en) → num2words of the decimal value.

    num2words drops or garbles an all-zero fraction (`2.0` → "two"), so those are read as the
    integer, the separator word and "zero" per digit.
    """

    def decimal(m: re.Match[str]) -> str:
        whole, frac = m.group(1), m.group(2)
        if frac.strip("0") == "":
            zeros = " ".join([_ZERO_WORD[lang]] * len(frac))
            return f"{num2words(int(whole), lang=lang)} {_DECIMAL_WORD[lang]} {zeros}"
        return num2words(Decimal(f"{whole}.{frac}"), lang=lang)

    return _DECIMAL[lang].sub(decimal, text)


def _integers(text: str, lang: str) -> str:
    return _INTEGER.sub(lambda m: num2words(int(m.group()), lang=lang), text)


# --- Dates -----------------------------------------------------------------------------------

_MONTHS_PL_GENITIVE = (
    "stycznia",
    "lutego",
    "marca",
    "kwietnia",
    "maja",
    "czerwca",
    "lipca",
    "sierpnia",
    "września",
    "października",
    "listopada",
    "grudnia",
)
_MONTHS_EN = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)
# A date is not glued to a word, a number or a dot-, slash- or hyphen-joined chain.
_DATE_START = r"(?<![\w.,/-])"
_DATE_END = r"(?![\w/]|[.,][0-9]|-\w)"
_PL_MONTH_ALT = "|".join(_MONTHS_PL_GENITIVE)
_EN_MONTH_ALT = "|".join(_MONTHS_EN)
_ISO_DATE = re.compile(rf"{_DATE_START}({_D}{{4}})-({_D}{{2}})-({_D}{{2}}){_DATE_END}")
_PL_DOT_DATE = re.compile(rf"{_DATE_START}({_D}{{1,2}})\.({_D}{{1,2}})\.({_D}{{4}}){_DATE_END}")
_PL_WORD_DATE = re.compile(
    rf"{_DATE_START}({_D}{{1,2}}){_SPACE}+({_PL_MONTH_ALT}){_SPACE}+({_D}{{4}}){_DATE_END}"
)
_EN_MONTH_DAY_DATE = re.compile(
    rf"(?<!\w)({_EN_MONTH_ALT}){_SPACE}+({_D}{{1,2}}),{_SPACE}*({_D}{{4}}){_DATE_END}"
)
_EN_DAY_MONTH_DATE = re.compile(
    rf"{_DATE_START}({_D}{{1,2}}){_SPACE}+({_EN_MONTH_ALT}){_SPACE}+({_D}{{4}}){_DATE_END}"
)
# pl `r.` right after a date's year → "roku".
_PL_DATE_R = re.compile(rf"{_SPACE}+r\.(?!\w)")

# A match -> (day, month, year).
DateParts = Callable[[re.Match[str]], tuple[int, int, int]]


def _date_words(day: int, month: int, year: int, lang: str) -> str | None:
    """A date read aloud, or None when the day or month is out of range."""
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return None
    if lang == "pl":
        ordinal = num2words(day, lang="pl", to="ordinal")
        return f"{ordinal} {_MONTHS_PL_GENITIVE[month - 1]} {num2words(year, lang='pl')}"
    ordinal = num2words(day, lang="en", to="ordinal")
    return f"{_MONTHS_EN[month - 1]} {ordinal}, {num2words(year, lang='en', to='year')}"


def _rewrite_dates(text: str, lang: str, pattern: re.Pattern[str], parts: DateParts) -> str:
    out: list[str] = []
    pos = 0
    for m in pattern.finditer(text):
        words = _date_words(*parts(m), lang)
        if words is None:
            continue  # not a real date: leave it to the number passes
        end = m.end()
        if lang == "pl":
            r = _PL_DATE_R.match(text, end)
            if r:
                words += " " + _abbreviation_word(r, "roku", True)
                end = r.end()
        out.append(text[pos : m.start()] + words)
        pos = end
    out.append(text[pos:])
    return "".join(out)


def _dates(text: str, lang: str) -> str:
    """pl `5.11.2026`, ISO, `5 listopada 2026`; en ISO, `November 5, 2026`, `5 November 2026`.

    A slash date (`5/11/2026`) is ambiguous and never read as a date.
    """
    text = _rewrite_dates(
        text, lang, _ISO_DATE, lambda m: (int(m.group(3)), int(m.group(2)), int(m.group(1)))
    )
    if lang == "pl":
        text = _rewrite_dates(
            text, lang, _PL_DOT_DATE, lambda m: (int(m.group(1)), int(m.group(2)), int(m.group(3)))
        )
        return _rewrite_dates(
            text,
            lang,
            _PL_WORD_DATE,
            lambda m: (int(m.group(1)), _MONTHS_PL_GENITIVE.index(m.group(2)) + 1, int(m.group(3))),
        )
    text = _rewrite_dates(
        text,
        lang,
        _EN_MONTH_DAY_DATE,
        lambda m: (int(m.group(2)), _MONTHS_EN.index(m.group(1)) + 1, int(m.group(3))),
    )
    return _rewrite_dates(
        text,
        lang,
        _EN_DAY_MONTH_DATE,
        lambda m: (int(m.group(1)), _MONTHS_EN.index(m.group(2)) + 1, int(m.group(3))),
    )


# --- Money -----------------------------------------------------------------------------------

# Written symbol or code -> ISO code.
_CURRENCY_TOKENS = {
    "zł": "PLN",
    "PLN": "PLN",
    "€": "EUR",
    "EUR": "EUR",
    "$": "USD",
    "USD": "USD",
    "£": "GBP",
    "GBP": "GBP",
    "CHF": "CHF",
    "Kč": "CZK",
    "CZK": "CZK",
}
_SYMBOLS_BEFORE = ("€", "$", "£")  # symbols written before the amount, glued or spaced
_CODES_BEFORE = ("PLN", "EUR", "USD", "GBP", "CHF", "CZK")  # codes before, always spaced
_CUR_AFTER_ALT = "|".join(sorted(map(re.escape, _CURRENCY_TOKENS), key=len, reverse=True))
_SYM_BEFORE_ALT = "|".join(map(re.escape, _SYMBOLS_BEFORE))
_CODE_BEFORE_ALT = "|".join(_CODES_BEFORE)
_CUR_END = r"(?!\w)"

# Currencies num2words declines itself, per language; the rest use `_LOCAL_CURRENCY`.
_NUM2WORDS_CURRENCIES = {
    "pl": frozenset({"PLN", "EUR", "USD"}),
    "en": frozenset({"PLN", "EUR", "USD", "GBP"}),
}

# Local word forms: (major forms, minor forms, major is feminine).
# pl forms are (1, 2–4 except 12–14, other); en forms are (1, other).
_LOCAL_CURRENCY: dict[str, dict[str, tuple[tuple[str, ...], tuple[str, ...], bool]]] = {
    "pl": {
        "GBP": (("funt", "funty", "funtów"), ("pens", "pensy", "pensów"), False),
        "CHF": (("frank", "franki", "franków"), ("centym", "centymy", "centymów"), False),
        "CZK": (("korona", "korony", "koron"), ("halerz", "halerze", "halerzy"), True),
    },
    "en": {
        "CHF": (("franc", "francs"), ("centime", "centimes"), False),
        "CZK": (("koruna", "korunas"), ("haler", "halers"), False),
    },
}

# num2words extras to shorten: pl "dolarów amerykańskich" → "dolarów", en "pounds sterling".
_CURRENCY_TRIM = re.compile(r" (?:amerykańsk\w*|sterling)(?=,|$)")
# num2words always names both parts, even a zero one ("pięć euro, zero centów").
_ZERO_MINOR = re.compile(r", zero \S+$")
_ZERO_MAJOR = re.compile(r"^zero \S+, ")
# pl "euro" is neuter: a major count of exactly 1 is "jedno euro", not num2words' "jeden euro".
# Anchored at the start, so "dwadzieścia jeden euro" is left alone.
_PL_ONE_EURO = re.compile(r"^jeden euro\b")

# An amount has at most two decimal places; `1,999 zł` is left to the number passes.
_MONEY_AMOUNT = {
    "pl": rf"{_D}{{1,3}}(?:{_PL_GROUP_SEP}{_D}{{3}})+(?:,{_D}{{1,2}})?|{_D}+(?:,{_D}{{1,2}})?",
    "en": rf"{_D}{{1,3}}(?:,{_D}{{3}})+(?:\.{_D}{{1,2}})?|{_D}+(?:\.{_D}{{1,2}})?",
}
_MONEY_RANGE_AFTER = {
    lang: re.compile(rf"{_NUM_START}({num})[{_DASHES}]({num}){_SPACE}?({_CUR_AFTER_ALT}){_CUR_END}")
    for lang, num in _MONEY_AMOUNT.items()
}
_MONEY_RANGE_BEFORE = {
    lang: re.compile(
        rf"(?<!\w)({_SYM_BEFORE_ALT}){_SPACE}?({num})[{_DASHES}](?:{_SYM_BEFORE_ALT})?({num}){_NUM_END}"
    )
    for lang, num in _MONEY_AMOUNT.items()
}
_MONEY_AFTER = {
    lang: re.compile(rf"{_NUM_START}({num}){_SPACE}?({_CUR_AFTER_ALT}){_CUR_END}")
    for lang, num in _MONEY_AMOUNT.items()
}
_MONEY_BEFORE = {
    lang: re.compile(
        rf"(?<!\w)(?:({_SYM_BEFORE_ALT}){_SPACE}?|({_CODE_BEFORE_ALT}){_SPACE})({num}){_NUM_END}"
    )
    for lang, num in _MONEY_AMOUNT.items()
}


def _parse_amount(written: str, lang: str) -> Decimal:
    if lang == "pl":
        return Decimal(re.sub(_PL_GROUP_SEP, "", written).replace(",", "."))
    return Decimal(written.replace(",", ""))


def _plural_index(n: int, lang: str) -> int:
    """Index into a local form tuple: pl 1 / 2–4 (not 12–14) / other; en 1 / other."""
    if n == 1:
        return 0
    if lang == "en":
        return 1
    return 1 if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14) else 2


def _cardinal(n: int, lang: str, feminine: bool = False) -> str:
    """Cardinal words; pl feminine nouns take "jedna" for 1 and "dwie" for a final 2."""
    words = num2words(n, lang=lang)
    if lang == "pl" and feminine:
        if n == 1:
            return "jedna"
        if n % 10 == 2 and n % 100 != 12:
            words = re.sub(r"\bdwa$", "dwie", words)
    return words


def _is_feminine(code: str, lang: str) -> bool:
    local = _LOCAL_CURRENCY[lang].get(code)
    return bool(local and local[2])


def _num2words_amount(amount: Decimal, code: str, lang: str) -> str:
    """num2words' currency text, long names trimmed, then a zero part dropped."""
    # A Decimal, never an int: num2words reads a bare int as minor units (199 → 1.99).
    words = num2words(amount, lang=lang, to="currency", currency=code)
    # Trim first: `_ZERO_MAJOR` expects one word before the comma ("zero dolarów, ...").
    words = _CURRENCY_TRIM.sub("", words)
    return _ZERO_MAJOR.sub("", _ZERO_MINOR.sub("", words))


def _amount_words(amount: Decimal, code: str, lang: str) -> str:
    """An amount in words with its currency; a zero minor or major part is dropped."""
    amount = amount.quantize(Decimal("0.01"))
    if code in _NUM2WORDS_CURRENCIES[lang]:
        words = _num2words_amount(amount, code, lang)
        if lang == "pl" and code == "EUR":
            words = _PL_ONE_EURO.sub("jedno euro", words)
        return words
    major_forms, minor_forms, feminine = _LOCAL_CURRENCY[lang][code]
    major = int(amount)
    minor = int((amount - major) * 100)
    parts = []
    if major or not minor:
        parts.append(f"{_cardinal(major, lang, feminine)} {major_forms[_plural_index(major, lang)]}")
    if minor:
        parts.append(f"{_cardinal(minor, lang)} {minor_forms[_plural_index(minor, lang)]}")
    return ", ".join(parts)


def _currency_word(n: int, code: str, lang: str) -> str:
    """The currency's name in the form a whole number `n` takes ("złotych" for 20)."""
    if code in _NUM2WORDS_CURRENCIES[lang]:
        words = _num2words_amount(Decimal(n).quantize(Decimal("0.01")), code, lang)
        return words.removeprefix(num2words(n, lang=lang) + " ")
    major_forms, _, _ = _LOCAL_CURRENCY[lang][code]
    return major_forms[_plural_index(n, lang)]


def _range_words(low: str, high: str, code: str, lang: str) -> str:
    """`10–20 zł` → "dziesięć do dwadzieścia złotych": both numbers nominative, currency once."""
    feminine = _is_feminine(code, lang)

    def number(written: str) -> str:
        value = _parse_amount(written, lang)
        if value == value.to_integral_value():
            return _cardinal(int(value), lang, feminine)
        return written  # a decimal bound is read by the decimals pass

    last = _parse_amount(high, lang)
    # A fractional last bound takes the "many" form, like 5.
    form_n = int(last) if last == last.to_integral_value() else 5
    return f"{number(low)} {_RANGE_WORD[lang]} {number(high)} {_currency_word(form_n, code, lang)}"


def _money(text: str, lang: str) -> str:
    """`12,50 zł`, `$12.50`, `€5`, `20 CHF`, `10–20 zł` → amounts in words."""
    tokens = _CURRENCY_TOKENS
    text = _MONEY_RANGE_AFTER[lang].sub(
        lambda m: _range_words(m.group(1), m.group(2), tokens[m.group(3)], lang), text
    )
    text = _MONEY_RANGE_BEFORE[lang].sub(
        lambda m: _range_words(m.group(2), m.group(3), tokens[m.group(1)], lang), text
    )
    text = _MONEY_AFTER[lang].sub(
        lambda m: _amount_words(_parse_amount(m.group(1), lang), tokens[m.group(2)], lang), text
    )
    return _MONEY_BEFORE[lang].sub(
        lambda m: _amount_words(
            _parse_amount(m.group(3), lang), tokens[m.group(1) or m.group(2)], lang
        ),
        text,
    )


# --- Abbreviations -----------------------------------------------------------------------

ABBREVIATIONS["pl"].update(
    {
        "ok.": "około",
        "np.": "na przykład",
        "tj.": "to jest",
        "m.in.": "między innymi",
        "itd.": "i tak dalej",
        "tzw.": "tak zwany",
        "godz.": "godzina",
    }
)
ABBREVIATIONS["en"].update(
    {
        "e.g.": "for example",
        "i.e.": "that is",
        "approx.": "approximately",
        "vs.": "versus",
    }
)
# Abbreviations that commonly close a sentence, so a capital after them means a new sentence.
_SENTENCE_FINAL = frozenset({"itd."})
# Capitalised forms that are also standalone words (`Ok.` the interjection): expanded only when
# the sentence goes on in lowercase or with a number (`Ok. pięć osób`).
_CAPITALISED_NEEDS_CONTINUATION = frozenset({"ok."})


def _capitalise(word: str) -> str:
    return word[:1].upper() + word[1:]


_ABBREVIATION = {
    lang: re.compile(
        r"(?<![\w.])("
        + "|".join(
            sorted(
                (re.escape(form) for key in table for form in (key, _capitalise(key))),
                key=len,
                reverse=True,
            )
        )
        + r")(?!\w)"
    )
    for lang, table in ABBREVIATIONS.items()
}


def _abbreviations(text: str, lang: str) -> str:
    """`ok.` → `około`, `Np.` → `Na przykład`; a dot that also ends the sentence is kept."""
    table = ABBREVIATIONS[lang]

    def expand(m: re.Match[str]) -> str:
        written = m.group(1)
        key = written if written in table else written[:1].lower() + written[1:]
        word = table[key]
        if written != key:
            if key in _CAPITALISED_NEEDS_CONTINUATION and not re.match(
                r"[ \t]+[a-ząćęłńóśźż0-9]", text[m.end() :]
            ):
                return written
            word = _capitalise(word)
        return _abbreviation_word(m, word, key in _SENTENCE_FINAL)

    return _ABBREVIATION[lang].sub(expand, text)


# --- Acronyms ------------------------------------------------------------------------------

# All-caps tokens said as a word, not spelled; kept small and only for clear cases. A token of
# six or more letters (UNESCO, PESEL-like) is never spelled anyway.
READ_AS_WORD_ACRONYMS["pl"] = frozenset(
    {"NATO", "NASA", "RAM", "ROM", "JSON", "YAML", "ASAP", "OK", "GIF", "PIN", "LOL", "PESEL"}
)
READ_AS_WORD_ACRONYMS["en"] = frozenset(
    {"NATO", "NASA", "RAM", "ROM", "JSON", "YAML", "ASAP", "OK", "GIF", "PIN", "LOL"}
)

_PL_LETTER_NAMES = dict(
    zip(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        (
            *("a", "be", "ce", "de", "e", "ef", "gie", "ha", "i", "jot", "ka", "el", "em"),
            *("en", "o", "pe", "ku", "er", "es", "te", "u", "fau", "wu", "iks", "igrek", "zet"),
        ),
        strict=True,
    )
)
# A whole token of 2-5 ASCII capitals with an optional plural `s`. Not glued to a letter, digit,
# underscore or hyphen on either side (`MyAPI`, `API_KEY`, `COVID-19` stay as written).
_ACRONYM = re.compile(r"(?<![\w-])([A-Z]{2,5})(s?)(?![\w-])")


def _pl_plural(name: str) -> str:
    """Plural of a pl letter name, used for the last letter of `PRs`.

    A name ending in a consonant takes `-y` (er → ery, em → emy, iks → iksy), or `-i` after
    k / g (igrek → igreki), as Polish spelling requires. A name ending in a vowel is left as is
    (`APIs` → "a pe i", `SDKs` → "es de ka"): such plurals are said without an ending.
    """
    if name[-1] in "aeiou":
        return name
    if name[-1] in "kg":
        return name + "i"
    return name + "y"


def _acronyms(text: str, lang: str) -> str:
    """`API` → pl "a pe i", en "A P I"; `PRs` → pl "pe ery", en "P Rs". Runs last."""
    keep = READ_AS_WORD_ACRONYMS[lang]

    def spell(m: re.Match[str]) -> str:
        letters, plural = m.group(1), m.group(2)
        if letters in keep:
            return m.group()
        if lang == "en":
            return " ".join(letters) + plural
        names = [_PL_LETTER_NAMES[ch] for ch in letters]
        if plural:
            names[-1] = _pl_plural(names[-1])
        return " ".join(names)

    return _ACRONYM.sub(spell, text)


# `year_suffix` is the `r.` abbreviation, taken while the year is still digits; a date's `r.` is
# taken by the dates pass itself.
PASSES.extend(
    [
        ("dates", _dates),
        ("money", _money),
        ("ranges", _ranges),
        ("percentages", _percentages),
        ("units", _units),
        ("year_suffix", _year_suffix),
        ("grouped_thousands", _grouped_thousands),
        ("decimals", _decimals),
        ("integers", _integers),
        ("abbreviations", _abbreviations),
        ("acronyms", _acronyms),
    ]
)


# --- Entry point ---------------------------------------------------------------------------


def _base_language(language: object) -> str | None:
    if not isinstance(language, str):
        return None
    base = re.split(r"[-_]", language.strip(), maxsplit=1)[0].lower()
    return base if base in SUPPORTED_LANGUAGES else None


def normalize(text: str, language: str) -> str:
    """Rewrite `text` into speakable words for `language` ("pl" / "en", locales allowed)."""
    lang = _base_language(language)
    if lang is None or not isinstance(text, str) or not text:
        return text
    try:
        masked, spans = _mask(text)
    except Exception:
        log.warning("normalize: masking protected spans failed; text left unchanged", exc_info=True)
        return text
    for name, fn in PASSES:
        try:
            masked = fn(masked, lang)
        except Exception:
            log.warning("normalize: pass %r failed; skipped", name, exc_info=True)
    try:
        return _unmask(masked, spans)
    except Exception:
        log.warning("normalize: restoring protected spans failed; text left unchanged", exc_info=True)
        return text
