import logging

from conftest import write_voice

FULL = {
    "language": "en", "locale": "en-US", "gender": "male",
    "label": "Lively comic voice", "multilingual": True,
    "ref_text": "Hello there.", "description": "comic",
}


def test_lists_bundled_and_custom_voices_with_their_source(voices_dir, custom_dir, make_client):
    write_voice(voices_dir, "comic-s13", FULL)
    write_voice(custom_dir, "my-voice", {**FULL, "locale": "pl-PL", "language": "pl"})
    body = make_client().get("/v1/voices").json()
    ids = [v["id"] for v in body["voices"]]
    assert ids[0] == "auto"
    assert set(ids[1:]) == {"comic-s13", "my-voice"}
    by_id = {v["id"]: v for v in body["voices"]}
    assert by_id["comic-s13"] == {"id": "comic-s13", "source": "bundled", **FULL}
    assert by_id["my-voice"]["source"] == "custom"
    assert by_id["my-voice"]["locale"] == "pl-PL"


def test_loads_a_legacy_json_with_null_metadata(voices_dir, custom_dir, make_client):
    write_voice(voices_dir, "en-male", {"language": "en", "description": "bootstrapped"})
    by_id = {v["id"]: v for v in make_client().get("/v1/voices").json()["voices"]}
    v = by_id["en-male"]
    assert v["language"] == "en" and v["description"] == "bootstrapped"
    assert v["source"] == "bundled"
    for field in ("locale", "gender", "label", "multilingual", "ref_text"):
        assert field in v and v[field] is None


def test_starts_without_a_custom_dir(voices_dir, custom_dir, make_client):
    write_voice(voices_dir, "pl-female", FULL)
    assert not custom_dir.exists()
    ids = [v["id"] for v in make_client().get("/v1/voices").json()["voices"]]
    assert ids == ["auto", "pl-female"]


def test_bundled_voice_wins_a_name_clash(voices_dir, custom_dir, make_client, caplog):
    write_voice(voices_dir, "comic-s13", {**FULL, "description": "bundled one"})
    write_voice(custom_dir, "comic-s13", {**FULL, "description": "custom one"})
    with caplog.at_level(logging.WARNING):
        voices = make_client().get("/v1/voices").json()["voices"]
    clash = [v for v in voices if v["id"] == "comic-s13"]
    assert len(clash) == 1
    assert clash[0]["source"] == "bundled" and clash[0]["description"] == "bundled one"
    assert any("comic-s13" in r.getMessage() for r in caplog.records if r.levelno == logging.WARNING)
