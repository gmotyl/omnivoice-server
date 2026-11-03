"""Render one audition sample per voice: the new reference clips and the existing voices alike.

  .venv/bin/python audition/render.py            # render what is missing
  .venv/bin/python audition/render.py --force    # re-render everything

For each audition/refs/<id>.wav it freezes a clone prompt into audition/voices/<id>.pt|.json|.wav
(same layout as voices/, so importing a pick is a copy). Every voice — new and existing —
reads the same panel-style sentence for its language at the server's default num_step, so the
samples sound like what the panel will play. Writes audition/samples/<id>.ogg (Opus 32 kb/s)
and audition/manifest.json for the picker page.
"""

import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import torch
from omnivoice import OmniVoice, VoiceClonePrompt

SR = 24000
HERE = Path(__file__).parent
ROOT = HERE.parent
REFS, VOICES, SAMPLES = HERE / "refs", HERE / "voices", HERE / "samples"
STEPS = int(os.environ.get("OMNIVOICE_STEPS", "16"))

SENTENCE = {
    "pl": "Gotowe. Testy przechodzą, zmiany są wypchnięte na branch, a pull request czeka na Twoje review.",
    "en": "Done. All the tests pass, the branch is pushed, and the pull request is waiting for your review.",
}


def encode_ogg(audio: np.ndarray, out: Path) -> None:
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0",
                    "-c:a", "libopus", "-b:a", "32k", str(out)], input=pcm, check=True)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--force", action="store_true")
    p.add_argument("--only", help="id prefix: render only these new voices, skip the installed ones (e.g. vb-)")
    p.add_argument("--langs", help="comma list: render every voice in each of these languages (default: its own)")
    p.add_argument("--manifest", default="manifest.json")
    a = p.parse_args()
    for d in (VOICES, SAMPLES):
        d.mkdir(exist_ok=True)

    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda:0", dtype=torch.float16)
    manifest = []

    # New candidates from reference clips.
    for meta_path in sorted(REFS.glob(f"{a.only or ''}*.json")):
        vid = meta_path.stem
        meta = json.loads(meta_path.read_text())
        pt = VOICES / f"{vid}.pt"
        if a.force or not pt.exists():
            prompt = model.create_voice_clone_prompt(ref_audio=str(REFS / f"{vid}.wav"), ref_text=meta["ref_text"])
            prompt.save(str(pt))
            shutil.copy(REFS / f"{vid}.wav", VOICES / f"{vid}.wav")
            desc = f"cloned from {meta['source']} speaker {meta['speaker']} ({meta['licence']})"
            (VOICES / f"{vid}.json").write_text(json.dumps({"language": meta["language"], "description": desc}, ensure_ascii=False) + "\n")
        manifest.append({"id": vid, "status": "new", **{k: v for k, v in meta.items() if k != "ref_text"}})

    # Existing voices, for a side-by-side comparison.
    for pt in [] if a.only else sorted((ROOT / "voices").glob("*.pt")):
        meta = json.loads((ROOT / "voices" / f"{pt.stem}.json").read_text())
        manifest.append({"id": pt.stem, "status": "installed", "source": "voice design", "licence": "CC-BY-NC (model)",
                         "language": meta["language"], "locale": "pl-PL" if meta["language"] == "pl" else "en-GB",
                         "description": meta.get("description", "")})

    for item in manifest:
        langs = a.langs.split(",") if a.langs else [item["language"]]
        item["samples"] = []
        src = VOICES if item["status"] == "new" else ROOT / "voices"
        prompt = None
        for lang in langs:
            # Native-language sample keeps the old name so earlier pages stay valid.
            fname = f"{item['id']}.ogg" if lang == item["language"] else f"{item['id']}.{lang}.ogg"
            item["samples"].append({"lang": lang, "file": fname})
            out = SAMPLES / fname
            if out.exists() and not a.force:
                continue
            prompt = prompt or VoiceClonePrompt.load(str(src / f"{item['id']}.pt"))
            audio = model.generate(text=SENTENCE[lang], language=lang, voice_clone_prompt=prompt, num_step=STEPS)[0]
            encode_ogg(np.asarray(audio, dtype=np.float32), out)
            print(f"ok {item['id']} [{lang}]: {len(audio) / SR:.1f}s", flush=True)

    (HERE / a.manifest).write_text(json.dumps({"sentence": SENTENCE, "steps": STEPS, "voices": manifest},
                                                   ensure_ascii=False, indent=1) + "\n")
    print(f"manifest: {len(manifest)} voices")


if __name__ == "__main__":
    main()
