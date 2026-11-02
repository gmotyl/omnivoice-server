"""Save a stable OmniVoice voice as a reusable clone prompt.

Two ways:
  # from your own 3–10 s reference clip and its exact transcript
  uv run python make_voice.py pl-greg --language pl --ref ref.wav --ref-text "Dokładny tekst nagrania."

  # bootstrap: generate a clip with voice design, then freeze it as a clone prompt
  uv run python make_voice.py pl-male --language pl --design "male, middle-aged, low pitch"

The bootstrap route turns a per-call random design voice into one that sounds the same on
every request. Listen to voices/<name>.wav and re-run (different seed = different voice)
until you like it.
"""

import argparse
import json
from pathlib import Path

import soundfile as sf
import torch
from omnivoice import OmniVoice

SR = 24000
VOICES = Path(__file__).parent / "voices"

BOOTSTRAP_TEXT = {
    "pl": "Dzień dobry. Będę dzisiaj czytać na głos odpowiedzi z panelu, spokojnie i wyraźnie.",
    "en": "Good morning. I will be reading the answers from the panel out loud for you today.",
}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("name")
    p.add_argument("--language", required=True)
    p.add_argument("--ref")
    p.add_argument("--ref-text")
    p.add_argument("--design", help="voice-design attributes for the bootstrap route")
    p.add_argument("--seed", type=int, default=0)
    a = p.parse_args()
    if bool(a.ref) == bool(a.design):
        p.error("give either --ref/--ref-text or --design")

    VOICES.mkdir(exist_ok=True)
    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda:0", dtype=torch.float16)

    if a.design:
        torch.manual_seed(a.seed)
        ref_text = BOOTSTRAP_TEXT.get(a.language, BOOTSTRAP_TEXT["en"])
        audio = model.generate(text=ref_text, language=a.language, instruct=a.design, num_step=32)[0]
        ref_path = VOICES / f"{a.name}.wav"
        sf.write(ref_path, audio, SR)
        description = f"bootstrapped from design '{a.design}' (seed {a.seed})"
    else:
        if not a.ref_text:
            p.error("--ref needs --ref-text (exact transcript)")
        ref_path, ref_text = Path(a.ref), a.ref_text
        description = f"cloned from {ref_path.name}"

    prompt = model.create_voice_clone_prompt(ref_audio=str(ref_path), ref_text=ref_text)
    prompt.save(str(VOICES / f"{a.name}.pt"))
    (VOICES / f"{a.name}.json").write_text(json.dumps({"language": a.language, "description": description}, ensure_ascii=False) + "\n")
    print(f"saved voices/{a.name}.pt ({description})")


if __name__ == "__main__":
    main()
