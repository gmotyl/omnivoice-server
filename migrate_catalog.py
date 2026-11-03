"""One-time migration of the bundled voice catalog (kept for the record).

  .venv/bin/python migrate_catalog.py

1. Copy the 15 audition picks audition/voices/<audition id>.{pt,json,wav} -> voices/<name>.*
2. Backfill locale, gender, label, multilingual and ref_text (read from each .pt's
   VoiceClonePrompt) for those 15 and for the kept pl-female / en-male.
3. Delete pl-male, en-female and the 14 cand-* voices.

Idempotent: re-running copies the same files, rewrites the same records and finds nothing
left to delete. The pick list (rename map, locale, gender, label) is Greg's audition list from
the 2026-11-03 grill, verbatim.
"""

import json
import shutil
from pathlib import Path

from omnivoice import VoiceClonePrompt

HERE = Path(__file__).parent
VOICES = HERE / "voices"
AUDITION = HERE / "audition" / "voices"
EXTS = (".pt", ".json", ".wav")

# audition id -> (name, locale, gender, label); all multilingual.
PICKS = {
    "vb-style-comic-s13": ("comic-s13", "en-US", "male", "Lively, expressive comic voice, seed 13 (voice design)"),
    "vb-style-comic-s14": ("comic-s14", "en-US", "male", "Lively, expressive comic voice, seed 14 (voice design)"),
    "vb-female_child_veryhigh_normal_british": ("female-child-veryhigh-british", "en-GB", "female", "British, female, child, very high pitch, normal (voice bank)"),
    "vb-female_elderly_low_normal_canadian": ("female-elderly-low-canadian", "en-CA", "female", "Canadian, female, elderly, low pitch, normal (voice bank)"),
    "vb-female_elderly_veryhigh_normal_british": ("female-elderly-veryhigh-british", "en-GB", "female", "British, female, elderly, very high pitch, normal (voice bank)"),
    "vb-style-gravelly-narrator-s11": ("gravelly-narrator-s11", "en-US", "male", "Deep, slow, gravelly narrator, seed 11 (voice design)"),
    "vb-style-gravelly-narrator-s13": ("gravelly-narrator-s13", "en-US", "male", "Deep, slow, gravelly narrator, seed 13 (voice design)"),
    "vb-male_elderly_veryhigh_normal_british": ("male-elderly-veryhigh-british", "en-GB", "male", "British, male, elderly, very high pitch, normal (voice bank)"),
    "vb-male_elderly_verylow_normal_british": ("male-elderly-verylow-british", "en-GB", "male", "British, male, elderly, very low pitch, normal (voice bank)"),
    "vb-male_elderly_low_normal_british": ("male-elderly-low-british", "en-GB", "male", "British, male, elderly, low pitch, normal (voice bank)"),
    "vb-male_elderly_verylow_normal_japanese": ("male-elderly-verylow-japanese", "en-GB", "male", "Japanese, male, elderly, very low pitch, normal (voice bank)"),
    "vb-style-nature-narrator-s11": ("nature-narrator-s11", "en-GB", "male", "Calm British nature narrator, seed 11 (voice design)"),
    "vb-style-nature-narrator-s12": ("nature-narrator-s12", "en-GB", "male", "Calm British nature narrator, seed 12 (voice design)"),
    "vb-style-nature-narrator-s13": ("nature-narrator-s13", "en-GB", "male", "Calm British nature narrator, seed 13 (voice design)"),
    "vb-style-pl-documentary-s14": ("pl-documentary-s14", "pl-PL", "female", "Polish documentary narrator, seed 14 (voice design)"),
}

# Kept legacy voices: name -> (locale, gender, label, multilingual).
KEPT = {
    "pl-female": ("pl-PL", "female", "Polish, young (spike)", False),
    "en-male": ("en-US", "male", "American, middle-aged, low (spike)", False),
}

RETIRED = ["pl-male", "en-female"] + sorted({p.stem for p in VOICES.glob("cand-*.*")})


def backfill(name: str, locale: str, gender: str, label: str, multilingual: bool) -> None:
    json_path = VOICES / f"{name}.json"
    meta = json.loads(json_path.read_text()) if json_path.exists() else {}
    meta.update(
        language=locale.split("-")[0].lower(),
        locale=locale,
        gender=gender,
        label=label,
        multilingual=multilingual,
        ref_text=VoiceClonePrompt.load(str(VOICES / f"{name}.pt")).ref_text,
    )
    json_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")


def main() -> None:
    missing = [f"{aid}{ext}" for aid in PICKS for ext in EXTS if not (AUDITION / f"{aid}{ext}").exists()]
    if missing:
        raise SystemExit(f"missing audition sources: {missing}")

    for aid, (name, locale, gender, label) in PICKS.items():
        for ext in EXTS:
            shutil.copy2(AUDITION / f"{aid}{ext}", VOICES / f"{name}{ext}")
        backfill(name, locale, gender, label, True)
    for name, (locale, gender, label, multilingual) in KEPT.items():
        backfill(name, locale, gender, label, multilingual)

    for name in RETIRED:
        for ext in EXTS:
            (VOICES / f"{name}{ext}").unlink(missing_ok=True)

    expected = {name for name, *_ in PICKS.values()} | set(KEPT)
    present = {p.stem for p in VOICES.glob("*.pt")}
    if present != expected:
        raise SystemExit(f"catalog mismatch: extra={present - expected} missing={expected - present}")
    print(f"bundled catalog: {len(present)} voices; retired: {', '.join(RETIRED)}")


if __name__ == "__main__":
    main()
