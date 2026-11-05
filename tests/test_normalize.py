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
