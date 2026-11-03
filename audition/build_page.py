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
    a = p.parse_args()

    manifest = json.loads((HERE / "manifest.json").read_text())
    in_catalog = set()
    if a.catalog:
        in_catalog = set(re.findall(r'id: "([^"]+)"', Path(a.catalog).read_text()))
    for v in manifest["voices"]:
        ogg = HERE / "samples" / f"{v['id']}.ogg"
        v["audio"] = "data:audio/ogg;base64," + base64.b64encode(ogg.read_bytes()).decode()
        v["inCatalog"] = v["id"] in in_catalog
        v["sampleS"] = round(float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(ogg)],
            capture_output=True, text=True, check=True).stdout), 1)
    html = TEMPLATE.read_text().replace("/*__DATA__*/null", json.dumps(manifest, ensure_ascii=False))
    Path(a.out).write_text(html)
    print(f"wrote {a.out}: {len(manifest['voices'])} voices, {len(html) / 1e6:.1f} MB, {len(in_catalog)} catalog ids")


if __name__ == "__main__":
    main()
