import server


def generate_kwargs(client, **body) -> dict:
    """POST a speech request and return the kwargs the fake model's generate received."""
    res = client.post("/v1/audio/speech", json={"input": "hello", "voice": "auto", "response_format": "wav", **body})
    assert res.status_code == 200, res.text
    return server.state["model"].generate_calls[-1]


def test_default_speed_applied_when_request_sends_none(make_client):
    client = make_client()
    assert generate_kwargs(client)["speed"] == server.DEFAULT_SPEED == 0.9


def test_request_speed_wins_over_default(make_client):
    client = make_client()
    assert generate_kwargs(client, speed=1.2)["speed"] == 1.2


def test_default_speed_of_one_passes_no_speed(monkeypatch, make_client):
    monkeypatch.setattr(server, "DEFAULT_SPEED", 1.0)
    client = make_client()
    assert "speed" not in generate_kwargs(client)
