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


# Passes still to come slot in by design.md § Rewrite order: dates and money before ranges,
# percentages and units between ranges and grouped thousands, abbreviations and acronyms last.
PASSES.extend(
    [
        ("ranges", _ranges),
        ("grouped_thousands", _grouped_thousands),
        ("decimals", _decimals),
        ("integers", _integers),
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
