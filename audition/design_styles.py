"""Generate style voices with OmniVoice Voice Design — several seeds per style — as audition refs.

  HF_HUB_OFFLINE=1 .venv/bin/python audition/design_styles.py

Voice Design only understands gender, age, pitch, accent and whisper, so a style is approximated
by its closest attribute set; delivery (pace, warmth, gravel) comes from whichever seed happens
to have it, which is why every style gets several seeds to choose from. Writes
audition/refs/vb-style-<slug>-s<seed>.wav + .json, so `render.py --only vb-` renders them with
the voice-bank picks.
"""

import json
from pathlib import Path

import soundfile as sf
import torch
from omnivoice import OmniVoice

HERE = Path(__file__).parent
REFS = HERE / "refs"
SR = 24000
SEEDS = (11, 12, 13, 14)
REF_TEXT = {
    "en": "Here, at the edge of the forest, the morning light reveals a world that is quietly waking up.",
    "pl": "Na skraju lasu poranne światło odsłania świat, który powoli i cicho budzi się do życia.",
}

# (slug, style name shown on the page, language, instruct, locale)
STYLES = [
    ("nature-narrator", "Calm British nature narrator", "en", "male, elderly, very low pitch, british accent", "en-GB"),
    ("pl-documentary", "Polish documentary narrator", "pl", "female, middle-aged, low pitch", "pl-PL"),
    ("gravelly-narrator", "Deep, slow, gravelly narrator", "en", "male, elderly, very low pitch, american accent", "en-US"),
    ("comic", "Lively, expressive comic voice", "en", "male, middle-aged, high pitch, american accent", "en-US"),
]


def main() -> None:
    REFS.mkdir(exist_ok=True)
    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda:0", dtype=torch.float16)
    for slug, style, lang, instruct, locale in STYLES:
        for seed in SEEDS:
            vid = f"vb-style-{slug}-s{seed}"
            if (REFS / f"{vid}.json").exists():
                continue
            torch.manual_seed(seed)
            audio = model.generate(text=REF_TEXT[lang], language=lang, instruct=instruct, num_step=32)[0]
            sf.write(REFS / f"{vid}.wav", audio, SR)
            parts = [p.strip() for p in instruct.split(",")]
            meta = {"source": "voice design", "licence": "CC-BY-NC (model)", "speaker": f"{slug}-s{seed}",
                    "language": lang, "locale": locale, "gender": parts[0], "age": parts[1],
                    "accent": parts[3].replace(" accent", "").capitalize() if len(parts) > 3 else "Polish",
                    "region": f"{style}, seed {seed}", "style": style, "instruct": instruct,
                    "ref_text": REF_TEXT[lang]}
            (REFS / f"{vid}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n")
            print(f"ok {vid}: {len(audio) / SR:.1f}s", flush=True)


if __name__ == "__main__":
    main()
