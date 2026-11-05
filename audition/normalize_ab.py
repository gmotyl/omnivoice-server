"""Normalisation A/B: render the verification sentences with normalisation off, then on.

  .venv/bin/python audition/normalize_ab.py [--out PAGE.html]

OMNIVOICE_NORMALIZE is read once at server import, so it cannot be flipped per request: the
script restarts the live server through ./omnivoicectl with OMNIVOICE_NORMALIZE=0 (baseline),
renders every sentence of audition/normalize_sentences.txt, restarts it with
OMNIVOICE_NORMALIZE=1 and renders them again. The flag is always set explicitly, never unset:
omnivoicectl fills unset variables from relay.env, which could otherwise decide either run.
Whatever happens, the server is left running with normalisation on. Each request asks for 16 steps. The normalised text shown on the page comes
from calling normalize.normalize directly. Audio is embedded as MP3 data URIs, so the page is
one self-contained file.
"""

import argparse
import base64
import html
import io
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import soundfile as sf

HERE = Path(__file__).parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
from normalize import normalize

SENTENCES = HERE / "normalize_sentences.txt"
# The author's workspace mockups dir when it exists, otherwise the gitignored out/ in this repo.
_WORKSPACE_MOCKUPS = Path("/srv/git/prv/projects/projects/tts-providers/mockups")
DEFAULT_OUT = (
    _WORKSPACE_MOCKUPS / "2026-11-05-omnivoice-normalize-ab.html"
    if _WORKSPACE_MOCKUPS.is_dir()
    else ROOT / "out" / "normalize-ab.html"
)
URL = f"http://127.0.0.1:{os.environ.get('OMNIVOICE_PORT', '8890')}"
VOICES = {"pl": "krystyna1", "en": "en-male"}
STEPS = 16
HEALTH_TIMEOUT_S = 300


def load_sentences() -> list[tuple[str, str]]:
    out = []
    for line in SENTENCES.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        lang, text = line.split("\t", 1)
        out.append((lang.strip(), text.strip()))
    return out


def http(path: str, body: dict | None = None, timeout: float = 120) -> bytes:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def wait_healthy() -> None:
    deadline = time.monotonic() + HEALTH_TIMEOUT_S
    while time.monotonic() < deadline:
        try:
            if json.loads(http("/health", timeout=2)).get("ok"):
                return
        except (urllib.error.URLError, OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError(f"server not healthy within {HEALTH_TIMEOUT_S} s")


def server_env_flag() -> str | None:
    """OMNIVOICE_NORMALIZE as the running server process sees it (None: unset)."""
    pid = (ROOT / "run" / "omnivoice.pid").read_text().strip()
    environ = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    for entry in environ:
        if entry.startswith(b"OMNIVOICE_NORMALIZE="):
            return entry.split(b"=", 1)[1].decode()
    return None


def restart(normalize_off: bool) -> None:
    # Set, never unset: a variable already in the environment wins over relay.env.
    expected = "0" if normalize_off else "1"
    env = {**os.environ, "OMNIVOICE_NORMALIZE": expected}
    print(f"restart: OMNIVOICE_NORMALIZE={expected}", flush=True)
    subprocess.run([str(ROOT / "omnivoicectl"), "restart"], env=env, check=True)
    wait_healthy()
    seen = server_env_flag()
    if seen != expected:
        raise RuntimeError(f"server runs with OMNIVOICE_NORMALIZE={seen!r}, expected {expected!r}")


def render(lang: str, text: str) -> dict:
    t0 = time.monotonic()
    wav = http(
        "/v1/audio/speech",
        {"input": text, "voice": VOICES[lang], "language": lang, "num_step": STEPS, "response_format": "wav"},
    )
    gen_s = time.monotonic() - t0
    info = sf.info(io.BytesIO(wav))
    mp3 = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-f", "mp3", "-b:a", "64k", "pipe:1"],
        input=wav, capture_output=True, check=True,
    ).stdout
    return {"len_s": info.frames / info.samplerate, "gen_s": gen_s, "mp3": base64.b64encode(mp3).decode()}


def render_all(sentences: list[tuple[str, str]], label: str) -> list[dict]:
    out = []
    for i, (lang, text) in enumerate(sentences, 1):
        r = render(lang, text)
        print(f"  {label} {i:2}/{len(sentences)} {lang} {r['len_s']:5.1f} s  {text[:60]}", flush=True)
        out.append(r)
    return out


def fmt_s(x: float) -> str:
    return f"{x:.1f}".replace(".", ",") + " s"


def audio(r: dict) -> str:
    return f'<audio controls preload=none src="data:audio/mpeg;base64,{r["mp3"]}"></audio>'


def page(rows: list[tuple[str, str, str, dict, dict]]) -> str:
    esc = html.escape
    body = []
    for lang, text, norm, raw, nrm in rows:
        flag = "" if nrm["len_s"] > raw["len_s"] else " <b>(nie dłużej)</b>"
        body.append(
            f"<tr><td><span class=m>{lang} · {VOICES[lang]}</span><br><code>{esc(text)}</code>"
            f"<br><span class=m>→</span> {esc(norm)}</td>"
            f"<td>{fmt_s(raw['len_s'])}<br>{audio(raw)}</td>"
            f"<td>{fmt_s(nrm['len_s'])}{flag}<br>{audio(nrm)}</td></tr>"
        )
    longer = sum(nrm["len_s"] > raw["len_s"] for *_, raw, nrm in rows)
    return (
        '<!doctype html><html lang="pl"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1"><title>OmniVoice normalisation A/B</title>\n'
        "<style>:root{--bg:#fff;--fg:#1b1b1f;--mut:#666;--line:#ddd}"
        "@media (prefers-color-scheme:dark){:root{--bg:#16171a;--fg:#e8e8ea;--mut:#9a9aa2;--line:#333}}\n"
        "body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:960px}"
        "table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left;"
        "vertical-align:top}audio{width:100%;max-width:260px;margin-top:4px}.m{color:var(--mut)}code{font-size:13px}</style>\n"
        "<h1>Normalizacja tekstu: bez vs z</h1>\n"
        f"<p class=m>Każde zdanie wyrenderowane na <code>{VOICES['pl']}</code> (pl) i <code>{VOICES['en']}</code> (en), "
        f"{STEPS} kroków: najpierw serwer z <code>OMNIVOICE_NORMALIZE=0</code>, potem z <code>OMNIVOICE_NORMALIZE=1</code>. "
        "Pod zdaniem: tekst po normalizacji (z <code>normalize.normalize</code>).</p>\n"
        "<table><tr><th>Zdanie → po normalizacji</th><th>Bez normalizacji</th><th>Z normalizacją</th></tr>\n"
        + "\n".join(body)
        + f"\n</table><p class=m>Nagranie z normalizacją jest dłuższe w {longer} z {len(rows)} zdań.</p></html>\n"
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--out", type=Path, default=DEFAULT_OUT, help=f"listening page (default: {DEFAULT_OUT})"
    )
    args = ap.parse_args()

    sentences = load_sentences()
    known = {v["id"] for v in json.loads(http("/v1/voices"))["voices"]}
    missing = sorted(set(VOICES.values()) - known)
    if missing:
        sys.exit(f"voices not on the server: {', '.join(missing)}")
    normalised = [normalize(text, lang) for lang, text in sentences]

    baseline_up = False
    try:
        baseline_up = True  # set first: a restart that fails half-way may leave the baseline up
        restart(normalize_off=True)
        raw = render_all(sentences, "raw")
        restart(normalize_off=False)
        baseline_up = False
        nrm = render_all(sentences, "norm")
    finally:
        if baseline_up:
            restart(normalize_off=False)

    rows = [(lang, text, norm, r, n) for (lang, text), norm, r, n in zip(sentences, normalised, raw, nrm, strict=True)]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(page(rows), encoding="utf-8")
    print(f"\n{'raw':>6} {'norm':>6}  sentence")
    for lang, text, _, r, n in rows:
        mark = "" if n["len_s"] > r["len_s"] else "  <- NOT longer"
        print(f"{r['len_s']:5.1f}s {n['len_s']:5.1f}s  {lang} {text}{mark}")
    print(f"page: {args.out}")


if __name__ == "__main__":
    main()
