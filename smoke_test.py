"""Hit a running server: health, voices, then one request per saved voice and format."""

import json
import sys
import time
import urllib.request
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8890"
OUT = Path(__file__).parent / "out"
OUT.mkdir(exist_ok=True)


def get(path: str) -> dict:
    with urllib.request.urlopen(BASE + path, timeout=10) as r:
        return json.load(r)


def speech(body: dict) -> tuple[bytes, dict, float]:
    req = urllib.request.Request(BASE + "/v1/audio/speech", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    t = time.perf_counter()
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
        return data, dict(r.headers), time.perf_counter() - t


# Wait for the model to load (first start downloads ~3 GB).
for _ in range(150):
    try:
        print("health", get("/health"))
        break
    except Exception:  # noqa: BLE001 - server not up yet; retry
        time.sleep(2)
else:
    sys.exit("server did not come up")

print("voices", [v["id"] for v in get("/v1/voices")["voices"]])
texts = {"pl": "Zadanie zakończone. Wszystkie testy przeszły, a gałąź jest gotowa do przeglądu.", "en": "Task finished. All tests passed and the branch is ready for review."}
for v in get("/v1/voices")["voices"]:
    lang = v["language"] or "en"
    data, h, wall = speech({"input": texts[lang], "voice": v["id"], "response_format": "mp3"})
    (OUT / f"server-{v['id']}.mp3").write_bytes(data)
    print(f"{v['id']:10s} wall={wall:.2f}s gen={h['x-gen-seconds']}s audio={h['x-audio-seconds']}s bytes={len(data)}")

for fmt in ("wav", "pcm", "opus", "flac"):
    data, h, wall = speech({"input": texts["pl"], "voice": "pl-female", "response_format": fmt, "speed": 1.1})
    print(f"format {fmt:5s} {h['content-type']:12s} bytes={len(data)} wall={wall:.2f}s")
