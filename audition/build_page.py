"""Build the self-contained voice picker page from audition/manifest.json + audition/samples/.

  .venv/bin/python audition/build_page.py <out.html> [--catalog <openaiVoices.ts>]

The page embeds every sample as a data URI (the Pavilio Mockups tab is an opaque-origin
iframe and loads nothing external). --catalog marks the voices already in the panel catalog.
"""

import argparse
import base64
import json
import re
import subprocess
from pathlib import Path

HERE = Path(__file__).parent
TEMPLATE = HERE / "page_template.html"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("out")
    p.add_argument("--catalog")
    p.add_argument("--manifest", default="manifest.json")
    p.add_argument("--title", default="OmniVoice voices — pick for the panel")
    a = p.parse_args()

    manifest = json.loads((HERE / a.manifest).read_text())
    in_catalog = set()
    if a.catalog:
        in_catalog = set(re.findall(r'id: "([^"]+)"', Path(a.catalog).read_text()))
    for v in manifest["voices"]:
        v["inCatalog"] = v["id"] in in_catalog
        samples = v.get("samples") or [{"lang": v["language"], "file": f"{v['id']}.ogg"}]
        v["audios"] = []
        for smp in samples:
            ogg = HERE / "samples" / smp["file"]
            dur = float(subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(ogg)],
                capture_output=True, text=True, check=True).stdout)
            v["audios"].append({"lang": smp["lang"], "s": round(dur, 1),
                                "src": "data:audio/ogg;base64," + base64.b64encode(ogg.read_bytes()).decode()})
        native = next((x for x in v["audios"] if x["lang"] == v["language"]), v["audios"][0])
        v["sampleS"] = native["s"]
    # Picks first, each followed by the voices found similar to it.
    order = {v["id"]: i for i, v in enumerate(manifest["voices"])}
    manifest["voices"].sort(key=lambda v: (v.get("similar_to") or v.get("speaker") or "", not v.get("pick", False), order[v["id"]]))
    html = (TEMPLATE.read_text().replace("/*__DATA__*/null", json.dumps(manifest, ensure_ascii=False))
            .replace("OmniVoice voices — pick for the panel", a.title))
    Path(a.out).write_text(html)
    print(f"wrote {a.out}: {len(manifest['voices'])} voices, {len(html) / 1e6:.1f} MB, {len(in_catalog)} catalog ids")


if __name__ == "__main__":
    main()
