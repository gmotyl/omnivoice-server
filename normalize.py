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

# Ordered (name, function(text, lang) -> text) passes, run after masking. Later tasks append here
# in the order of design.md § Rewrite order: dates, money, ranges, percentages, units, grouped
# thousands, decimals, integers, abbreviations, acronyms.
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


def _decimals(text: str, lang: str) -> str:
    """`1,2` (pl), `1.2` (en) → num2words of the decimal value."""
    return _DECIMAL[lang].sub(
        lambda m: num2words(Decimal(f"{m.group(1)}.{m.group(2)}"), lang=lang), text
    )


def _integers(text: str, lang: str) -> str:
    return _INTEGER.sub(lambda m: num2words(int(m.group()), lang=lang), text)


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
_ABBREVIATION = {
    lang: re.compile(
        r"(?<![\w.])(" + "|".join(sorted(map(re.escape, table), key=len, reverse=True)) + r")(?!\w)"
    )
    for lang, table in ABBREVIATIONS.items()
}


def _abbreviations(text: str, lang: str) -> str:
    """`ok.` → `około`; a dot that also ends the sentence is kept."""
    table = ABBREVIATIONS[lang]
    return _ABBREVIATION[lang].sub(
        lambda m: _abbreviation_word(m, table[m.group(1)], m.group(1) in _SENTENCE_FINAL), text
    )


# Passes still to come slot in by design.md § Rewrite order: dates and money before ranges,
# acronyms after abbreviations. `year_suffix` is the `r.` abbreviation, taken while the year is
# still digits.
PASSES.extend(
    [
        ("ranges", _ranges),
        ("percentages", _percentages),
        ("units", _units),
        ("year_suffix", _year_suffix),
        ("grouped_thousands", _grouped_thousands),
        ("decimals", _decimals),
        ("integers", _integers),
        ("abbreviations", _abbreviations),
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
