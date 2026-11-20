import numpy as np

import server
from conftest import write_voice

BASE = {"language": "en", "locale": "en-US", "gender": "male", "label": "v", "multilingual": True,
        "ref_text": "Hi.", "description": None}


def test_hidden_voice_is_unlisted_but_still_synthesises(voices_dir, custom_dir, make_client):
    write_voice(voices_dir, "quiet", {**BASE, "hidden": True})
    write_voice(voices_dir, "shown", BASE)
    client = make_client()
    ids = [v["id"] for v in client.get("/v1/voices").json()["voices"]]
    assert "quiet" not in ids and "shown" in ids
    assert client.post("/v1/audio/speech", json={"input": "hi", "voice": "quiet"}).status_code == 200


def test_voice_speed_multiplies_the_effective_speed(voices_dir, custom_dir, make_client):
    write_voice(custom_dir, "fast", {**BASE, "speed": 1.1})
    client = make_client()
    client.post("/v1/audio/speech", json={"input": "hi", "voice": "fast"})
    assert server.state["model"].generate_calls[-1]["speed"] == server.DEFAULT_SPEED * 1.1


def test_voice_gain_scales_the_audio(voices_dir, custom_dir, make_client, monkeypatch):
    write_voice(custom_dir, "quieter", {**BASE, "gain_db": -6.0})
    client = make_client()
    model = server.state["model"]
    monkeypatch.setattr(model, "generate", lambda **kw: [np.full(2400, 0.5, dtype=np.float32)])
    res = client.post("/v1/audio/speech", json={"input": "hi", "voice": "quieter", "response_format": "pcm"})
    samples = np.frombuffer(res.content, dtype="<i2") / 32767
    assert abs(samples.max() - 0.5 * 10 ** (-6 / 20)) < 1e-3
