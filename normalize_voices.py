#!/usr/bin/env python3
"""Level the custom voices and split each into a -en and a -pl twin.

For every base voice in voices-custom/ (names not ending in -en/-pl):
  1. loudness-normalise its reference wav (EBU R128, -23 LUFS) with ffmpeg;
  2. clone it twice through the running server, as <name>-en (en-GB) and <name>-pl (pl-PL), so the
     language default, and with it number reading, differs per twin;
  3. synthesise a test sentence per twin, measure its loudness and write the correcting `gain_db`
     into the twin's .json (the server applies it to every request after a restart);
  4. move the original three files to voices-custom/original/.

Usage: normalize_voices.py [--url http://127.0.0.1:8890] [--target -20] [base ...]
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import tempfile
import urllib.request
import uuid
from pathlib import Path

CUSTOM = Path(__file__).parent / "voices-custom"
TWINS = {"en": "en-GB", "pl": "pl-PL"}
TEST = {
    "en": "In 2025 about 1,250 people paid $19.99 each, and 37% of them came back before the 3rd of May.",
    "pl": "W 2025 roku około 1250 osób zapłaciło po 19,99 zł, a 37% z nich wróciło przed 3 maja.",
}


def ffmpeg(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-y", *args], capture_output=True, text=True, check=True)


def lufs(path: Path) -> float:
    err = ffmpeg("-i", str(path), "-af", "ebur128", "-f", "null", "-").stderr
    return float(re.findall(r"I:\s+(-?[\d.]+) LUFS", err)[-1])


def post_voice(url: str, name: str, wav: Path, meta: dict, locale: str) -> None:
    b = uuid.uuid4().hex
    fields = {"name": name, "ref_text": meta["ref_text"], "locale": locale, "gender": meta.get("gender") or "neutral",
              "label": f"{meta.get('label') or name} ({locale[:2]})", "multilingual": "true"}
    body = b"".join(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items())
    body += f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{wav.name}"\r\nContent-Type: audio/wav\r\n\r\n'.encode()
    body += wav.read_bytes() + f"\r\n--{b}--\r\n".encode()
    req = urllib.request.Request(f"{url}/v1/voices", body, {"Content-Type": f"multipart/form-data; boundary={b}"})
    urllib.request.urlopen(req, timeout=300).read()


def synth(url: str, voice: str, text: str, out: Path) -> None:
    req = urllib.request.Request(f"{url}/v1/audio/speech", json.dumps({"input": text, "voice": voice}).encode(),
                                 {"Content-Type": "application/json"})
    out.write_bytes(urllib.request.urlopen(req, timeout=300).read())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8890")
    ap.add_argument("--target", type=float, default=-20.0, help="target LUFS of synthesised speech")
    ap.add_argument("bases", nargs="*")
    a = ap.parse_args()
    bases = a.bases or sorted(p.stem for p in CUSTOM.glob("*.pt") if not re.search(r"-(en|pl)$", p.stem))
    (CUSTOM / "original").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        for base in bases:
            meta = json.loads((CUSTOM / f"{base}.json").read_text())
            norm = Path(tmp) / f"{base}.wav"
            ffmpeg("-i", str(CUSTOM / f"{base}.wav"), "-af", "loudnorm=I=-23:TP=-2:LRA=11", "-ac", "1", "-ar", "24000", str(norm))
            for lang, locale in TWINS.items():
                twin = f"{base}-{lang}"
                post_voice(a.url, twin, norm, meta, locale)
                out = Path(tmp) / f"{twin}-test.wav"
                synth(a.url, twin, TEST[lang], out)
                gain = round(a.target - lufs(out), 1)
                jp = CUSTOM / f"{twin}.json"
                rec = json.loads(jp.read_text())
                rec["gain_db"] = gain
                jp.write_text(json.dumps(rec, ensure_ascii=False, indent=2) + "\n")
                print(f"{twin}: gain_db {gain:+.1f}", flush=True)
            for ext in (".pt", ".json", ".wav"):
                shutil.move(CUSTOM / f"{base}{ext}", CUSTOM / "original" / f"{base}{ext}")


if __name__ == "__main__":
    main()
