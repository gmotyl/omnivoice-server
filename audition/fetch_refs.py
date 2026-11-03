"""Fetch reference clips for new OmniVoice candidate voices from open speech corpora.

  .venv/bin/python audition/fetch_refs.py

Sources (both CC-BY 4.0, read through the Hugging Face datasets-server API, no full download):
  - VCTK (sanchit-gandhi/vctk): British/Irish English speakers with age, gender, accent, region.
    2-3 short utterances of one speaker are joined into one 6-10 s reference clip.
  - Multilingual LibriSpeech Polish (facebook/multilingual_librispeech, config polish):
    LibriVox narrators; the shortest 10-13 s clip per speaker. No gender label, so it is
    estimated from median F0.

Writes audition/refs/<id>.wav (24 kHz mono) + audition/refs/<id>.json (ref_text + metadata).
"""

import io
import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

SR = 24000
OUT = Path(__file__).parent / "refs"
API = "https://datasets-server.huggingface.co"

# VCTK speakers to sample: a spread of accent x gender (picked from the dataset statistics).
VCTK_PER_GROUP = {("English", "F"): 4, ("English", "M"): 4, ("Scottish", "F"): 2, ("Scottish", "M"): 2,
                  ("Irish", "F"): 1, ("Irish", "M"): 1, ("NorthernIrish", "F"): 1, ("NorthernIrish", "M"): 1,
                  ("Welsh", "F"): 1, ("Welsh", "M"): 1}


def fetch(url: str) -> bytes:
    # The datasets-server answers 429 under bursts and 500 while an index warms up; back off.
    for attempt in range(8):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503) or attempt == 7:
                raise
            time.sleep(min(60, 5 * 2 ** attempt))
    raise RuntimeError("unreachable")


def get(path: str, **params) -> dict:
    return json.loads(fetch(f"{API}/{path}?{urllib.parse.urlencode(params)}"))


def load_audio(src: str) -> np.ndarray:
    raw = fetch(src)
    # ffmpeg handles wav and opus alike; decode to 24 kHz mono float32.
    pcm = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(SR), "-f", "f32le", "pipe:1"],
                         input=raw, capture_output=True, check=True).stdout
    return np.frombuffer(pcm, dtype=np.float32)


def median_f0(audio: np.ndarray) -> float:
    f0, voiced, _ = librosa.pyin(audio, fmin=60, fmax=400, sr=SR)
    f0 = f0[voiced]
    return float(np.median(f0)) if f0.size else 0.0


def save(vid: str, audio: np.ndarray, meta: dict) -> None:
    audio = audio / max(1e-6, float(np.abs(audio).max())) * 0.9
    sf.write(OUT / f"{vid}.wav", audio, SR)
    meta["duration"] = round(len(audio) / SR, 2)
    meta["median_f0"] = round(median_f0(audio))
    (OUT / f"{vid}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n")
    print(f"ok {vid}: {meta['duration']}s F0 {meta['median_f0']} Hz  {meta.get('accent', '')} {meta.get('gender', '')}")


def vctk() -> None:
    ds = dict(dataset="sanchit-gandhi/vctk", config="default", split="train")
    total_rows = get("size", dataset=ds["dataset"])["size"]["dataset"]["num_rows"]
    want = dict(VCTK_PER_GROUP)
    seen = set()
    # Rows are grouped by speaker (~400-1000 each); a page every 700 rows lands in each speaker.
    for offset in range(0, total_rows, 700):
        rows = [r["row"] for r in get("rows", offset=offset, length=80, **ds)["rows"]]
        spk = rows[len(rows) // 2]["speaker_id"]
        rows = [r for r in rows if r["speaker_id"] == spk]
        if spk in seen or not rows:
            continue
        seen.add(spk)
        first = rows[0]
        key = (first["accent"], first["gender"])
        if want.get(key, 0) <= 0:
            continue
        if (OUT / f"vctk-{spk}.json").exists():  # resume: already fetched
            want[key] -= 1
            continue
        # Join utterances of 2.5-4.5 s each until the clip is 6-10 s long.
        parts, texts, total = [], [], 0.0
        for row in rows:
            if not row["text"].strip().endswith((".", "?", "!")):
                continue
            a = load_audio(row["audio"][0]["src"])
            a, _ = librosa.effects.trim(a, top_db=30)
            d = len(a) / SR
            if not 2.5 <= d <= 4.5:
                continue
            parts += [a, np.zeros(int(0.35 * SR), dtype=np.float32)]
            texts.append(row["text"].strip())
            total += d + 0.35
            if total >= 7.0:
                break
        if total < 6.0:
            print(f"skip {spk}: only {total:.1f}s of clean utterances")
            continue
        want[key] -= 1
        save(f"vctk-{spk}", np.concatenate(parts[:-1]), {
            "source": "VCTK", "licence": "CC-BY-4.0", "speaker": spk, "language": "en",
            "locale": "en-IE" if first["accent"] in ("Irish", "NorthernIrish") else "en-GB",
            "gender": "female" if first["gender"] == "F" else "male", "age": first["age"],
            "accent": first["accent"], "region": first["region"], "ref_text": " ".join(texts)})
        if not any(v > 0 for v in want.values()):
            break
    print("vctk unfilled groups:", {k: v for k, v in want.items() if v > 0})


def mls_polish() -> None:
    best: dict[str, dict] = {}
    for split in ("9_hours", "dev", "test"):
        ds = dict(dataset="facebook/multilingual_librispeech", config="polish", split=split)
        n = get("rows", offset=0, length=1, **ds)["num_rows_total"]
        for offset in range(0, n, 100):
            for r in get("rows", offset=offset, length=100, **ds)["rows"]:
                row = r["row"]
                d = float(row["audio_duration"])
                cur = best.get(row["speaker_id"])
                # Prefer the shortest clip of at least 10 s (MLS clips are 10-20 s).
                if cur is None or d < float(cur["audio_duration"]):
                    best[row["speaker_id"]] = row
    for spk, row in sorted(best.items()):
        if (OUT / f"mls-pl-{spk}.json").exists():  # resume: already fetched
            continue
        a = load_audio(row["audio"][0]["src"])
        f0 = median_f0(a)
        book = row["original_path"].rsplit("/", 2)[-2].replace("_librivox", "")
        save(f"mls-pl-{spk}", a, {
            "source": "MLS Polish (LibriVox)", "licence": "CC-BY-4.0", "speaker": spk, "language": "pl",
            "locale": "pl-PL", "gender": "female" if f0 >= 165 else "male", "gender_estimated": True,
            "accent": "Polish", "region": book, "ref_text": row["transcript"]})


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    vctk()
    mls_polish()
