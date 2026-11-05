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
