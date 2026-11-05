import json
import subprocess
from pathlib import Path

import pytest
import soundfile as sf
from conftest import FakeVoiceClonePrompt, write_voice

import server

FIELDS = {
    "name": "my-voice",
    "ref_text": "you've arrived, it's been my honor",
    "locale": "pl-PL",
    "gender": "male",
    "label": "My voice (own recording)",
    "multilingual": "true",
}


@pytest.fixture(scope="session")
def m4a_bytes(tmp_path_factory) -> bytes:
    """A tiny real m4a (0.5 s, 44.1 kHz stereo sine) made with ffmpeg."""
    out = tmp_path_factory.mktemp("fixtures") / "sample.m4a"
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5",
         "-ac", "2", "-ar", "44100", "-c:a", "aac", str(out)],
        check=True,
    )
    return out.read_bytes()


def post_voice(client, audio: bytes, **overrides):
    data = {**FIELDS, **overrides}
    return client.post("/v1/voices", data=data, files={"file": ("sample.m4a", audio, "audio/mp4")})


def snapshot(directory: Path) -> dict[str, bytes]:
    if not directory.exists():
        return {}
    return {p.relative_to(directory).as_posix(): p.read_bytes() for p in sorted(directory.rglob("*")) if p.is_file()}


def test_creates_a_custom_voice_usable_for_speech_without_restart(custom_dir, make_client, m4a_bytes):
    client = make_client()
    model = server.state["model"]
    lock_held: list[bool] = []
    original = model.create_voice_clone_prompt

    def spy(**kwargs):
        lock_held.append(server.gen_lock.locked())
        return original(**kwargs)

    model.create_voice_clone_prompt = spy

    res = post_voice(client, m4a_bytes)
    assert res.status_code == 201, res.text
    body = res.json()
    assert body == {
        "id": "my-voice", "source": "custom", "language": "pl", "locale": "pl-PL", "gender": "male",
        "label": "My voice (own recording)", "multilingual": True,
        "ref_text": FIELDS["ref_text"], "description": None,
    }
    assert lock_held == [True]

    assert sorted(p.name for p in custom_dir.iterdir()) == ["my-voice.json", "my-voice.pt", "my-voice.wav"]
    info = sf.info(str(custom_dir / "my-voice.wav"))
    assert (info.samplerate, info.channels) == (24000, 1)
    saved = json.loads((custom_dir / "my-voice.json").read_text())
    assert saved["locale"] == "pl-PL" and saved["multilingual"] is True

    listed = {v["id"]: v for v in client.get("/v1/voices").json()["voices"]}
    assert listed["my-voice"]["source"] == "custom"

    speech = client.post("/v1/audio/speech", json={"input": "Cześć.", "voice": "my-voice"})
    assert speech.status_code == 200, speech.text
    call = model.generate_calls[-1]
    prompt = call["voice_clone_prompt"]
    assert isinstance(prompt, FakeVoiceClonePrompt)
    assert prompt.ref_text == FIELDS["ref_text"]
    assert call["language"] == "pl"


def test_replaces_an_existing_custom_voice(custom_dir, make_client, m4a_bytes):
    write_voice(custom_dir, "my-voice", {"language": "en", "ref_text": "old", "label": "old"})
    client = make_client()
    res = post_voice(client, m4a_bytes, ref_text="new transcript", label="new")
    assert res.status_code == 201, res.text
    assert res.json()["label"] == "new"
    assert json.loads((custom_dir / "my-voice.json").read_text())["ref_text"] == "new transcript"
    assert (custom_dir / "my-voice.pt").read_bytes() == b"fake-prompt"
    assert sorted(p.name for p in custom_dir.iterdir()) == ["my-voice.json", "my-voice.pt", "my-voice.wav"]

    client.post("/v1/audio/speech", json={"input": "Hi.", "voice": "my-voice"})
    assert server.state["model"].generate_calls[-1]["voice_clone_prompt"].ref_text == "new transcript"


def test_refuses_a_bundled_name_with_409(voices_dir, custom_dir, make_client, m4a_bytes):
    write_voice(voices_dir, "comic-s13", {"language": "en"})
    client = make_client()
    before = snapshot(voices_dir)
    res = post_voice(client, m4a_bytes, name="comic-s13")
    assert res.status_code == 409
    assert res.json() == {"detail": "bundled voice — pick another name"}
    assert snapshot(custom_dir) == {}
    assert snapshot(voices_dir) == before
    assert server.state["model"].clone_calls == []


@pytest.mark.parametrize(
    "overrides, audio",
    [
        ({"name": "My Voice"}, None),
        ({"name": "-leading-dash"}, None),
        ({"name": "auto"}, None),
        ({"ref_text": "   "}, None),
        ({"locale": "pl_PL"}, None),
        ({"gender": "robot"}, None),
        ({"multilingual": "yes"}, None),
        ({}, b"this is definitely not audio"),
    ],
    ids=["bad-name-case", "bad-name-dash", "reserved-name-auto", "blank-transcript", "bad-locale",
         "bad-gender", "bad-multilingual", "undecodable-file"],
)
def test_rejects_a_bad_name_blank_transcript_undecodable_file(custom_dir, make_client, m4a_bytes, overrides, audio):
    client = make_client()
    res = post_voice(client, audio if audio is not None else m4a_bytes, **overrides)
    assert res.status_code == 400, res.text
    assert res.json()["detail"]
    assert snapshot(custom_dir) == {}
    assert "my-voice" not in server.state["voices"]
    assert "auto" not in server.state["voices"]


def test_leaves_no_partial_files_when_cloning_fails(custom_dir, make_client, m4a_bytes):
    client = make_client()
    assert post_voice(client, m4a_bytes).status_code == 201
    before = snapshot(custom_dir)
    old_prompt = server.state["voices"]["my-voice"].prompt

    server.state["model"].clone_error = RuntimeError("bad audio")
    res = post_voice(client, m4a_bytes, ref_text="replacement", label="replacement")
    assert res.status_code in (400, 500)
    assert "bad audio" in res.json()["detail"]
    assert snapshot(custom_dir) == before
    assert server.state["voices"]["my-voice"].prompt is old_prompt

    res = post_voice(client, m4a_bytes, name="other-voice")
    assert res.status_code in (400, 500)
    assert snapshot(custom_dir) == before
    assert "other-voice" not in server.state["voices"]


def test_gives_400_when_decoding_times_out(custom_dir, make_client, m4a_bytes, monkeypatch):
    client = make_client()

    def hang(*args, **kwargs):
        assert kwargs.get("timeout") == server.FFMPEG_TIMEOUT_S
        raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])

    monkeypatch.setattr(server.subprocess, "run", hang)
    res = post_voice(client, m4a_bytes)
    assert res.status_code == 400
    assert "timed out" in res.json()["detail"]
    assert snapshot(custom_dir) == {}
