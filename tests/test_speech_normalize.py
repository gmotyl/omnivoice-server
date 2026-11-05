import pytest
from conftest import write_voice

import server


def speak(client, **body) -> str:
    """POST a speech request and return the text the fake model's generate received."""
    res = client.post("/v1/audio/speech", json={"response_format": "wav", **body})
    assert res.status_code == 200, res.text
    return server.state["model"].generate_calls[-1]["text"]


def test_speech_normalises_polish(make_client):
    client = make_client()
    assert speak(client, input="1,2 s", voice="auto", language="pl") == "jeden przecinek dwa sekundy"


def test_speech_uses_voice_language(voices_dir, make_client):
    write_voice(voices_dir, "ania", {"language": "pl", "locale": "pl-PL"})
    client = make_client()
    assert speak(client, input="1,2 s", voice="ania") == "jeden przecinek dwa sekundy"


def test_speech_normalises_english(make_client):
    client = make_client()
    assert speak(client, input="1.2 s", voice="auto", language="en") == "one point two seconds"


def test_speech_other_language_unchanged(make_client):
    client = make_client()
    assert speak(client, input="1,2 s", voice="auto", language="de") == "1,2 s"
    assert speak(client, input="1,2 s", voice="auto") == "1,2 s"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(None, True), ("", True), ("1", True), ("on", True), ("0", False), ("false", False), ("OFF", False), (" False ", False)],
)
def test_env_flag_parsing(monkeypatch, raw, expected):
    if raw is None:
        monkeypatch.delenv("OMNIVOICE_NORMALIZE", raising=False)
    else:
        monkeypatch.setenv("OMNIVOICE_NORMALIZE", raw)
    assert server._env_flag("OMNIVOICE_NORMALIZE") is expected


def test_speech_switch_off(monkeypatch, make_client):
    monkeypatch.setattr(server, "NORMALIZE_ENABLED", False)
    client = make_client()
    assert speak(client, input="1,2 s", voice="auto", language="pl") == "1,2 s"
