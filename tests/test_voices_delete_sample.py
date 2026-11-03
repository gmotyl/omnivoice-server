import server
from conftest import write_voice


def listed_ids(client) -> list[str]:
    return [v["id"] for v in client.get("/v1/voices").json()["voices"]]


def test_deletes_a_custom_voice(voices_dir, custom_dir, make_client):
    write_voice(custom_dir, "my-voice", {"language": "pl"})
    write_voice(custom_dir, "keep-me", {"language": "en"})
    client = make_client()
    lock_held: list[bool] = []
    real_unlink = server.Path.unlink

    def spy(self, *args, **kwargs):
        lock_held.append(server.gen_lock.locked())
        return real_unlink(self, *args, **kwargs)

    server.Path.unlink = spy
    try:
        res = client.delete("/v1/voices/my-voice")
    finally:
        server.Path.unlink = real_unlink

    assert res.status_code == 204, res.text
    assert res.content == b""
    assert lock_held and all(lock_held)
    assert sorted(p.name for p in custom_dir.iterdir()) == ["keep-me.json", "keep-me.pt", "keep-me.wav"]
    assert "my-voice" not in server.state["voices"]
    assert "my-voice" not in listed_ids(client)
    assert client.post("/v1/audio/speech", json={"input": "Hi.", "voice": "my-voice"}).status_code == 404


def test_refuses_to_delete_bundled_and_auto_404_for_unknown(voices_dir, custom_dir, make_client):
    write_voice(voices_dir, "comic-s13", {"language": "en"})
    client = make_client()
    before = sorted(p.name for p in voices_dir.iterdir())

    res = client.delete("/v1/voices/comic-s13")
    assert res.status_code == 403
    assert sorted(p.name for p in voices_dir.iterdir()) == before
    assert "comic-s13" in server.state["voices"]

    res = client.delete("/v1/voices/auto")
    assert res.status_code == 400
    assert res.json()["detail"]

    assert client.delete("/v1/voices/nope").status_code == 404
    # A name that could never be saved is unknown too, and never becomes a path.
    assert client.delete("/v1/voices/..%2Fvoices%2Fcomic-s13").status_code == 404
    assert client.delete("/v1/voices/Bad.Name").status_code == 404
    assert sorted(p.name for p in voices_dir.iterdir()) == before


def test_serves_a_voices_reference_sample(voices_dir, custom_dir, make_client):
    write_voice(voices_dir, "comic-s13", {"language": "en"})
    (voices_dir / "comic-s13.wav").write_bytes(b"RIFF-bundled")
    write_voice(custom_dir, "my-voice", {"language": "pl"})
    (custom_dir / "my-voice.wav").write_bytes(b"RIFF-custom")
    write_voice(voices_dir, "no-wav", {"language": "en"}, wav=False)
    client = make_client()

    for name, body in (("comic-s13", b"RIFF-bundled"), ("my-voice", b"RIFF-custom")):
        res = client.get(f"/v1/voices/{name}/sample")
        assert res.status_code == 200, res.text
        assert res.headers["content-type"] == "audio/wav"
        assert res.content == body

    for name in ("nope", "auto", "no-wav", "Bad.Name"):
        assert client.get(f"/v1/voices/{name}/sample").status_code == 404, name
