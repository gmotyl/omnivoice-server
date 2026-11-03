"""Pull picked voices (plus their nearest neighbours) out of the mimba OmniVoice voice bank.

  uv run --no-project --with pyarrow --with numpy python audition/voicebank_pick.py [<name>…] [--similar 6]

The bank (HF dataset mimba/omnivoice-voicebank, gated, CC-BY-NC-SA-4.0) is downloaded to
audition/voicebank/ with `hf download … --repo-type dataset --local-dir audition/voicebank`.
Names given are appended to audition/voicebank-picks.txt, so picks accumulate across runs.
For every pick, the --similar closest voices from the deduplicated list (voices_clean.csv) are
added too, ranked by cosine similarity of the bank's speaker embeddings.

Writes audition/refs/vb-<name>.wav + .json in the fetch_refs.py layout, so render.py picks
them up unchanged.
"""

import argparse
import csv
import json
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

HERE = Path(__file__).parent
BANK = HERE / "voicebank"
PICKS = HERE / "voicebank-picks.txt"
REFS = HERE / "refs"
LOCALE = {"british": "en-GB", "american": "en-US", "australian": "en-AU", "canadian": "en-CA", "indian": "en-IN"}


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("names", nargs="*")
    p.add_argument("--similar", type=int, default=6)
    a = p.parse_args()

    picks = [n for n in PICKS.read_text().split() if n] if PICKS.exists() else []
    for n in a.names:
        if n not in picks:
            picks.append(n)
    PICKS.write_text("\n".join(picks) + "\n")

    clean = {row["name"] for row in csv.DictReader((BANK / "voices_clean.csv").open())}
    rows = {}
    for shard in sorted((BANK / "data").glob("*.parquet")):
        for r in pq.read_table(shard).to_pylist():
            rows[r["name"]] = r
    missing = [n for n in picks if n not in rows]
    if missing:
        raise SystemExit(f"not in the voice bank: {missing}")

    names = sorted(clean)
    emb = np.array([rows[n]["embedding"] for n in names], dtype=np.float32)
    emb /= np.linalg.norm(emb, axis=1, keepdims=True) + 1e-9

    chosen: dict[str, dict] = {n: {"pick": True} for n in picks}
    for n in picks:
        q = np.asarray(rows[n]["embedding"], dtype=np.float32)
        sims = emb @ (q / (np.linalg.norm(q) + 1e-9))
        ranked = [(names[i], float(sims[i])) for i in np.argsort(-sims) if names[i] not in picks]
        for other, s in ranked[: a.similar]:
            chosen.setdefault(other, {"pick": False, "similar_to": n, "similarity": round(s, 3)})

    REFS.mkdir(exist_ok=True)
    for n, extra in chosen.items():
        r = rows[n]
        (REFS / f"vb-{n}.wav").write_bytes(r["ref_audio"]["bytes"])
        meta = {"source": "mimba voicebank", "licence": "CC-BY-NC-SA-4.0", "speaker": n, "language": "en",
                "locale": LOCALE.get(r["accent"], "en-GB"), "gender": r["gender"], "age": r["age"],
                "accent": r["accent"].capitalize(), "region": f"{r['pitch']}, {r['style']}",
                "instruct": r["instruct"], "ref_text": r["ref_text"], **extra}
        (REFS / f"vb-{n}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n")
        tag = "PICK" if extra["pick"] else f"~{extra['similar_to']} {extra['similarity']}"
        print(f"ok vb-{n}  {tag}")


if __name__ == "__main__":
    main()
