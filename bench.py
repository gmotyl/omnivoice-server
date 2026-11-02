"""Smoke test + rough benchmark for OmniVoice on the local GPU.

Measures model load time, peak VRAM, and real-time factor (RTF) for English and Polish
in auto-voice and voice-design modes. Writes samples to out/.
"""

import time
from pathlib import Path

import soundfile as sf
import torch
from omnivoice import OmniVoice

SR = 24000
OUT = Path(__file__).parent / "out"
OUT.mkdir(exist_ok=True)

CASES = [
    ("en-auto", "en", None, "Hello! This is OmniVoice running locally on the panel machine. The build finished and all tests passed."),
    ("en-design", "en", "male, middle-aged, low pitch, american accent", "Hello! This is OmniVoice running locally on the panel machine. The build finished and all tests passed."),
    ("pl-auto", "pl", None, "Cześć! To jest OmniVoice uruchomiony lokalnie na komputerze z panelem. Budowanie zakończone, wszystkie testy przeszły."),
    ("pl-design-m", "pl", "male, middle-aged, low pitch", "Cześć! To jest OmniVoice uruchomiony lokalnie na komputerze z panelem. Budowanie zakończone, wszystkie testy przeszły."),
    ("pl-design-f", "pl", "female, young adult", "Cześć! To jest OmniVoice uruchomiony lokalnie na komputerze z panelem. Budowanie zakończone, wszystkie testy przeszły."),
]


def main() -> None:
    t0 = time.perf_counter()
    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda:0", dtype=torch.float16)
    print(f"load: {time.perf_counter() - t0:.1f}s, vram after load: {torch.cuda.memory_allocated() / 2**20:.0f} MiB")

    # Warm-up so the first measured case does not pay CUDA init / kernel compile.
    model.generate(text="Warm up.", language="en")

    for num_step in (32, 16):
        for name, lang, instruct, text in CASES:
            torch.cuda.reset_peak_memory_stats()
            torch.cuda.synchronize()
            t = time.perf_counter()
            audio = model.generate(text=text, language=lang, instruct=instruct, num_step=num_step)[0]
            torch.cuda.synchronize()
            dt = time.perf_counter() - t
            secs = len(audio) / SR
            peak = torch.cuda.max_memory_allocated() / 2**20
            sf.write(OUT / f"{name}-s{num_step}.wav", audio, SR)
            print(f"{name:12s} steps={num_step:2d} gen={dt:5.2f}s audio={secs:5.2f}s RTF={dt / secs:.3f} peak={peak:.0f} MiB")


if __name__ == "__main__":
    main()
