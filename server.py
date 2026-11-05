"""OmniVoice behind an OpenAI-compatible speech API, for anytts / the Pavilio panel.

Endpoints:
  POST /v1/audio/speech   {"input", "voice", "response_format", "speed", "language"?} -> audio bytes
  GET  /v1/voices         saved voices + the built-in "auto" voice
  POST /v1/voices         multipart (file, name, ref_text, locale, gender, label, multilingual)
                          -> clones a custom voice into the custom dir, live without a restart
  DELETE /v1/voices/{name}         removes a custom voice (bundled -> 403, "auto" -> 400)
  GET  /v1/voices/{name}/sample   the voice's reference wav (audio/wav)
  GET  /health            model/device status

Voices:
  - "<name>"              a saved clone prompt: <dir>/<name>.pt (+ <dir>/<name>.json voice record)
                          from the bundled dir (voices/, tracked) or the custom dir (voices-custom/)
  - "auto"                model picks a voice (varies per call)
  - "design:<attrs>"      voice design, e.g. "design:female, low pitch" (stable for en/zh only)

Env: OMNIVOICE_HOST (127.0.0.1), OMNIVOICE_PORT (8890), OMNIVOICE_STEPS (16),
     OMNIVOICE_DEVICE (cuda:0), OMNIVOICE_DEFAULT_VOICE (auto),
     OMNIVOICE_VOICES_DIR (voices), OMNIVOICE_CUSTOM_DIR (voices-custom); relative to this file
     OMNIVOICE_NORMALIZE (on): spell out numbers/units for pl/en before synthesis; 0/false/off disable
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from omnivoice import OmniVoice, VoiceClonePrompt
from pydantic import BaseModel, Field

from normalize import normalize

SR = 24000
ROOT = Path(__file__).parent
HOST = os.environ.get("OMNIVOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("OMNIVOICE_PORT", "8890"))
STEPS = int(os.environ.get("OMNIVOICE_STEPS", "16"))
DEVICE = os.environ.get("OMNIVOICE_DEVICE", "cuda:0")
DEFAULT_VOICE = os.environ.get("OMNIVOICE_DEFAULT_VOICE", "auto")


def _env_flag(var: str) -> bool:
    """A default-on switch: only 0, false or off (any case) turn it off."""
    return os.environ.get(var, "").strip().lower() not in ("0", "false", "off")


NORMALIZE_ENABLED = _env_flag("OMNIVOICE_NORMALIZE")  # read once at import

MEDIA_TYPES = {
    "wav": "audio/wav",
    "flac": "audio/flac",
    "pcm": "audio/pcm",
    "mp3": "audio/mpeg",
    "opus": "audio/ogg",
    "aac": "audio/aac",
}

# Voice record metadata fields beyond id/source; a legacy .json may lack any of them (-> None).
META_FIELDS = ("language", "locale", "gender", "label", "multilingual", "ref_text", "description")

VOICE_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
LOCALE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$")
GENDERS = ("male", "female", "neutral")
RESERVED_NAMES = ("auto",)  # built-in voice ids that can never be saved, replaced or deleted
FFMPEG_TIMEOUT_S = 120

log = logging.getLogger("omnivoice")
state: dict = {}
gen_lock = asyncio.Lock()  # one generation at a time on the single GPU


def _env_dir(var: str, default: str) -> Path:
    path = Path(os.environ.get(var, default))
    return path if path.is_absolute() else ROOT / path


def voices_dir() -> Path:
    """Bundled voices: tracked in git, read-only for the API."""
    return _env_dir("OMNIVOICE_VOICES_DIR", "voices")


def custom_dir() -> Path:
    """Custom voices: gitignored, the only dir POST/DELETE write to. May not exist."""
    return _env_dir("OMNIVOICE_CUSTOM_DIR", "voices-custom")


class Voice:
    def __init__(self, name: str, prompt: VoiceClonePrompt, source: str, meta: dict):
        self.name, self.prompt, self.source = name, prompt, source
        self.meta = {field: meta.get(field) for field in META_FIELDS}

    @property
    def language(self) -> str | None:
        return self.meta["language"]

    def record(self) -> dict:
        return {"id": self.name, "source": self.source, **self.meta}


def load_dir(directory: Path, source: str) -> dict[str, Voice]:
    voices: dict[str, Voice] = {}
    if not directory.is_dir():
        return voices
    for pt in sorted(directory.glob("*.pt")):
        meta_path = pt.with_suffix(".json")
        meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
        voices[pt.stem] = Voice(pt.stem, VoiceClonePrompt.load(str(pt)), source, meta)
    return voices


def load_voices() -> dict[str, Voice]:
    voices = load_dir(voices_dir(), "bundled")
    for name, voice in load_dir(custom_dir(), "custom").items():
        if name in voices:
            log.warning("custom voice '%s' clashes with a bundled voice; the bundled one wins", name)
            continue
        voices[name] = voice
    return voices


@asynccontextmanager
async def lifespan(_: FastAPI):
    t = time.perf_counter()
    dtype = torch.float16 if DEVICE.startswith("cuda") else torch.float32
    state["model"] = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map=DEVICE, dtype=dtype)
    state["voices"] = load_voices()
    state["model"].generate(text="Warm up.", language="en", num_step=STEPS)  # pay CUDA init before first request
    state["load_s"] = round(time.perf_counter() - t, 1)
    print(f"omnivoice ready in {state['load_s']}s on {DEVICE}, voices: {list(state['voices'])}", flush=True)
    yield
    state.clear()


app = FastAPI(title="omnivoice-local", lifespan=lifespan)


class SpeechRequest(BaseModel):
    input: str = Field(min_length=1, max_length=4096)
    model: str = "omnivoice"
    voice: str | None = None
    response_format: Literal["wav", "flac", "pcm", "mp3", "opus", "aac"] = "wav"
    speed: float | None = Field(default=None, ge=0.25, le=4.0)
    language: str | None = None  # extension: ISO code, e.g. "pl"; falls back to the voice's language
    num_step: int | None = Field(default=None, ge=4, le=64)  # extension: quality/speed trade-off


def encode(audio: np.ndarray, fmt: str) -> bytes:
    if fmt == "pcm":  # 16-bit little-endian mono, 24 kHz (OpenAI's pcm format)
        return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()
    if fmt in ("wav", "flac"):
        buf = io.BytesIO()
        sf.write(buf, audio, SR, format=fmt.upper(), subtype="PCM_16" if fmt == "wav" else None)
        return buf.getvalue()
    codec = {"mp3": ["-f", "mp3", "-b:a", "128k"], "opus": ["-f", "ogg", "-c:a", "libopus"], "aac": ["-f", "adts"]}[fmt]
    wav = encode(audio, "wav")
    proc = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", *codec, "pipe:1"], input=wav, capture_output=True, check=False)
    if proc.returncode != 0:
        raise HTTPException(500, f"ffmpeg failed: {proc.stderr.decode()[:300]}")
    return proc.stdout


def build_kwargs(req: SpeechRequest) -> dict:
    voice = req.voice or DEFAULT_VOICE
    kwargs: dict = {"text": req.input, "num_step": req.num_step or STEPS}
    if req.speed:
        kwargs["speed"] = req.speed
    language = req.language
    if voice.startswith("design:"):
        kwargs["instruct"] = voice.removeprefix("design:").strip()
    elif voice != "auto":
        v = state["voices"].get(voice)
        if v is None:
            raise HTTPException(404, f"unknown voice '{voice}'; see GET /v1/voices")
        kwargs["voice_clone_prompt"] = v.prompt
        language = language or v.language
    if language:
        kwargs["language"] = language
        if NORMALIZE_ENABLED:
            # normalize() leaves anything but pl/en untouched and reduces pl-PL -> pl itself
            kwargs["text"] = normalize(req.input, language)
    return kwargs


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest) -> Response:
    kwargs = build_kwargs(req)
    async with gen_lock:
        t = time.perf_counter()
        audio = (await asyncio.to_thread(state["model"].generate, **kwargs))[0]
        gen_s = time.perf_counter() - t
    body = encode(audio, req.response_format)
    return Response(
        content=body,
        media_type=MEDIA_TYPES[req.response_format],
        headers={"X-Gen-Seconds": f"{gen_s:.3f}", "X-Audio-Seconds": f"{len(audio) / SR:.3f}"},
    )


@app.get("/v1/voices")
def voices() -> dict:
    auto = {"id": "auto", "source": None, **{f: None for f in META_FIELDS}, "description": "model-chosen, varies per call"}
    return {"default": DEFAULT_VOICE, "voices": [auto, *(v.record() for v in state["voices"].values())]}


def to_wav(src: Path, dst: Path) -> None:
    """Decode any ffmpeg-readable sample into 24 kHz mono 16-bit wav; 400 if it can't be decoded."""
    try:
        proc = subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-ac", "1", "-ar", str(SR), "-c:a", "pcm_s16le", str(dst)],
            capture_output=True,
            timeout=FFMPEG_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(400, f"decoding the audio file timed out after {FFMPEG_TIMEOUT_S}s") from exc
    if proc.returncode != 0 or not dst.exists() or dst.stat().st_size == 0:
        raise HTTPException(400, f"could not decode the audio file: {proc.stderr.decode(errors='replace')[:300]}")


@app.post("/v1/voices", status_code=201)
async def create_voice(
    file: UploadFile = File(...),  # noqa: B008 - idiomatic FastAPI dependency
    name: str = Form(""),
    ref_text: str = Form(""),
    locale: str = Form(""),
    gender: str = Form(""),
    label: str = Form(""),
    multilingual: str = Form("false"),
) -> JSONResponse:
    # Validate everything before touching the disk.
    if not VOICE_NAME.match(name):
        raise HTTPException(400, f"invalid voice name '{name}': use a-z, 0-9 and '-', 1-64 chars, not starting with '-'")
    if name in RESERVED_NAMES:
        raise HTTPException(400, f"'{name}' is a reserved name — pick another name")
    existing = state["voices"].get(name)
    if (existing is not None and existing.source == "bundled") or (voices_dir() / f"{name}.pt").exists():
        raise HTTPException(409, "bundled voice — pick another name")
    if not ref_text.strip():
        raise HTTPException(400, "ref_text (the sample's transcript) must not be blank")
    if not LOCALE.match(locale):
        raise HTTPException(400, f"invalid locale '{locale}', e.g. pl-PL")
    if gender not in GENDERS:
        raise HTTPException(400, f"gender must be one of {', '.join(GENDERS)}")
    if multilingual not in ("true", "false"):
        raise HTTPException(400, "multilingual must be 'true' or 'false'")

    meta = {
        "language": locale.split("-")[0].lower(),
        "locale": locale,
        "gender": gender,
        "label": label.strip() or None,
        "multilingual": multilingual == "true",
        "ref_text": ref_text.strip(),
        "description": None,
    }

    target = custom_dir()
    target.mkdir(parents=True, exist_ok=True)
    # Stage every file in a hidden temp dir inside the custom dir (same filesystem, so the final
    # renames are atomic; load_dir only globs top-level *.pt, so it never sees the staging dir).
    tmp = Path(tempfile.mkdtemp(prefix=".tmp-", dir=target))
    try:
        upload = tmp / "upload"
        upload.write_bytes(await file.read())
        wav = tmp / f"{name}.wav"
        await asyncio.to_thread(to_wav, upload, wav)

        # The clone prompt runs on the same single GPU as generation; the lock also serialises the
        # file writes and the state update, so concurrent writes for one name cannot interleave.
        async with gen_lock:
            try:
                prompt = await asyncio.to_thread(
                    state["model"].create_voice_clone_prompt, ref_audio=str(wav), ref_text=meta["ref_text"]
                )
            except Exception as exc:  # surface any model failure as a client-visible detail
                log.exception("clone prompt failed for '%s'", name)
                raise HTTPException(400, f"voice cloning failed: {exc}") from exc

            prompt.save(str(tmp / f"{name}.pt"))
            (tmp / f"{name}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
            # Everything is staged; only now replace the live files (wav, json, then pt last, because
            # load_dir keys a voice on its .pt).
            for ext in (".wav", ".json", ".pt"):
                os.replace(tmp / f"{name}{ext}", target / f"{name}{ext}")
            voice = Voice(name, prompt, "custom", meta)
            state["voices"][name] = voice
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    return JSONResponse(voice.record(), status_code=201)


def known_voice(name: str) -> Voice:
    """Look a voice up by name; 404 unless the name is valid and loaded. Callers build paths only
    from the returned voice, so a crafted name never reaches the filesystem."""
    voice = state["voices"].get(name) if VOICE_NAME.match(name) else None
    if voice is None:
        raise HTTPException(404, f"unknown voice '{name}'; see GET /v1/voices")
    return voice


def voice_dir(voice: Voice) -> Path:
    return voices_dir() if voice.source == "bundled" else custom_dir()


@app.delete("/v1/voices/{name}", status_code=204)
async def delete_voice(name: str) -> Response:
    if name in RESERVED_NAMES:
        raise HTTPException(400, f"'{name}' is built in and can't be deleted")
    voice = known_voice(name)
    if voice.source == "bundled":
        raise HTTPException(403, "bundled voice — can't be deleted")
    async with gen_lock:  # serialise with POST /v1/voices writes for the same name
        target = custom_dir()
        # .pt first: load_dir keys a voice on it, so a half-done delete never leaves a live voice.
        for ext in (".pt", ".json", ".wav"):
            (target / f"{voice.name}{ext}").unlink(missing_ok=True)
        state["voices"].pop(voice.name, None)
    return Response(status_code=204)


@app.get("/v1/voices/{name}/sample")
def voice_sample(name: str) -> FileResponse:
    voice = known_voice(name)
    wav = voice_dir(voice) / f"{voice.name}.wav"
    if not wav.is_file():
        raise HTTPException(404, f"voice '{name}' has no reference sample")
    return FileResponse(wav, media_type="audio/wav")


@app.get("/health")
def health() -> dict:
    return {
        "ok": "model" in state,
        "device": DEVICE,
        "cuda": torch.cuda.is_available(),
        "vram_mib": round(torch.cuda.memory_allocated() / 2**20) if torch.cuda.is_available() else None,
        "num_step": STEPS,
        "load_s": state.get("load_s"),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
