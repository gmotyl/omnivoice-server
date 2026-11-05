"""Bootstrap a batch of candidate voices with one model load (same recipe as make_voice.py).

  uv run python make_candidates.py            # make every candidate missing from voices/
  uv run python make_candidates.py --force    # remake them all

Each candidate is a voice-design clip frozen as a clone prompt in voices/<name>.pt|.json|.wav.
Prints duration and median F0 of each bootstrap clip as a sanity check (male ~85-180 Hz,
female ~165-280 Hz). Restart the server afterwards so the new voices are served.
"""

import argparse
import json

import librosa
import numpy as np
import soundfile as sf
import torch
from omnivoice import OmniVoice

from make_voice import BOOTSTRAP_TEXT, SR, VOICES

# (name, language, design, seed)
CANDIDATES = [
    ("cand-en-gb-f1", "en", "female, young adult, moderate pitch, british accent", 1),
    ("cand-en-gb-f2", "en", "female, middle-aged, low pitch, british accent", 2),
    ("cand-en-gb-f3", "en", "female, young adult, high pitch, british accent", 3),
    ("cand-en-gb-m1", "en", "male, young adult, moderate pitch, british accent", 1),
    ("cand-en-gb-m2", "en", "male, middle-aged, low pitch, british accent", 2),
    ("cand-en-gb-m3", "en", "male, elderly, low pitch, british accent", 3),
    ("cand-pl-f1", "pl", "female, young adult, moderate pitch", 1),
    ("cand-pl-f2", "pl", "female, middle-aged, low pitch", 2),
    ("cand-pl-f3", "pl", "female, young adult, high pitch", 3),
    ("cand-pl-f4", "pl", "female, middle-aged, moderate pitch", 4),
    ("cand-pl-m1", "pl", "male, young adult, moderate pitch", 1),
    ("cand-pl-m2", "pl", "male, middle-aged, very low pitch", 2),
    ("cand-pl-m3", "pl", "male, elderly, low pitch", 3),
    ("cand-pl-m4", "pl", "male, young adult, low pitch", 4),
]


def median_f0(audio: np.ndarray) -> float:
    f0, voiced, _ = librosa.pyin(audio.astype(np.float32), fmin=60, fmax=400, sr=SR)
    f0 = f0[voiced]
    return float(np.median(f0)) if f0.size else 0.0


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--force", action="store_true")
    a = p.parse_args()

    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda:0", dtype=torch.float16)
    for name, lang, design, seed in CANDIDATES:
        if (VOICES / f"{name}.pt").exists() and not a.force:
            print(f"skip {name} (exists)")
            continue
        try:
            torch.manual_seed(seed)
            ref_text = BOOTSTRAP_TEXT[lang]
            audio = model.generate(text=ref_text, language=lang, instruct=design, num_step=32)[0]
            ref_path = VOICES / f"{name}.wav"
            sf.write(ref_path, audio, SR)
            prompt = model.create_voice_clone_prompt(ref_audio=str(ref_path), ref_text=ref_text)
            prompt.save(str(VOICES / f"{name}.pt"))
            description = f"bootstrapped from design '{design}' (seed {seed})"
            (VOICES / f"{name}.json").write_text(
                json.dumps({"language": lang, "description": description}, ensure_ascii=False) + "\n"
            )
            print(f"ok {name}: {len(audio) / SR:.1f}s, median F0 {median_f0(np.asarray(audio)):.0f} Hz")
        except Exception as e:  # noqa: BLE001 - keep going; report the failure
            print(f"FAIL {name}: {e!r}")


if __name__ == "__main__":
    main()
