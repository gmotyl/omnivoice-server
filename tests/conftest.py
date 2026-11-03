"""Shared pytest fixtures: a fake OmniVoice model, tmp voice dirs and a TestClient.

The real OmniVoice model is never loaded. `server.OmniVoice` and `server.VoiceClonePrompt` are
swapped for fakes, and both voice dirs point at `tmp_path` via the env vars the server reads.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server  # noqa: E402


class FakeVoiceClonePrompt:
    """Stands in for omnivoice.VoiceClonePrompt; remembers where it came from."""

    def __init__(self, ref_audio: str | None = None, ref_text: str | None = None, path: str | None = None):
        self.ref_audio, self.ref_text, self.path = ref_audio, ref_text, path

    @classmethod
    def load(cls, path: str) -> "FakeVoiceClonePrompt":
        return cls(path=path)

    def save(self, path: str) -> None:
        Path(path).write_bytes(b"fake-prompt")


class FakeOmniVoice:
    """Stands in for omnivoice.OmniVoice: records calls, returns short silence."""

    def __init__(self) -> None:
        self.generate_calls: list[dict] = []
        self.clone_calls: list[dict] = []
        self.clone_error: Exception | None = None  # set to make create_voice_clone_prompt fail

    @classmethod
    def from_pretrained(cls, *_args, **_kwargs) -> "FakeOmniVoice":
        return cls()

    def generate(self, **kwargs) -> list[np.ndarray]:
        self.generate_calls.append(kwargs)
        return [np.zeros(server.SR // 10, dtype=np.float32)]

    def create_voice_clone_prompt(self, ref_audio: str, ref_text: str, **_kwargs) -> FakeVoiceClonePrompt:
        self.clone_calls.append({"ref_audio": ref_audio, "ref_text": ref_text})
        if self.clone_error is not None:
            raise self.clone_error
        return FakeVoiceClonePrompt(ref_audio=ref_audio, ref_text=ref_text)


@pytest.fixture(autouse=True)
def fake_omnivoice(monkeypatch):
    monkeypatch.setattr(server, "OmniVoice", FakeOmniVoice)
    monkeypatch.setattr(server, "VoiceClonePrompt", FakeVoiceClonePrompt)
    yield
    server.state.clear()


@pytest.fixture
def voices_dir(tmp_path, monkeypatch) -> Path:
    d = tmp_path / "voices"
    d.mkdir()
    monkeypatch.setenv("OMNIVOICE_VOICES_DIR", str(d))
    return d


@pytest.fixture
def custom_dir(tmp_path, monkeypatch) -> Path:
    """The custom dir path; NOT created, so tests can cover a missing dir."""
    d = tmp_path / "voices-custom"
    monkeypatch.setenv("OMNIVOICE_CUSTOM_DIR", str(d))
    return d


def write_voice(directory: Path, name: str, meta: dict | None = None, wav: bool = True) -> None:
    """Write a fake voice (`.pt`, optional `.json` and `.wav`) into a voice dir."""
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{name}.pt").write_bytes(b"fake-prompt")
    if meta is not None:
        (directory / f"{name}.json").write_text(json.dumps(meta))
    if wav:
        (directory / f"{name}.wav").write_bytes(b"RIFF-fake")


@pytest.fixture
def make_client(voices_dir, custom_dir):
    """Factory: start the app (lifespan runs with the fake model) once the dirs are seeded."""
    from fastapi.testclient import TestClient

    clients: list[TestClient] = []

    def _make() -> TestClient:
        client = TestClient(server.app)
        client.__enter__()
        clients.append(client)
        return client

    yield _make
    for client in clients:
        client.__exit__(None, None, None)
