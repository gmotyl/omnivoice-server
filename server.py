"""OmniVoice behind an OpenAI-compatible speech API, for anytts / the Pavilio panel.

Endpoints:
  POST /v1/audio/speech   {"input", "voice", "response_format", "speed", "language"?} -> audio bytes
  GET  /v1/voices         saved voices + the built-in "auto" voice
  GET  /health            model/device status

Voices:
  - "<name>"              a saved clone prompt: voices/<name>.pt (+ voices/<name>.json with language)
  - "auto"                model picks a voice (varies per call)
  - "design:<attrs>"      voice design, e.g. "design:female, low pitch" (stable for en/zh only)

Env: OMNIVOICE_HOST (127.0.0.1), OMNIVOICE_PORT (8890), OMNIVOICE_STEPS (16),
     OMNIVOICE_DEVICE (cuda:0), OMNIVOICE_DEFAULT_VOICE (auto)
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from omnivoice import OmniVoice, VoiceClonePrompt
from pydantic import BaseModel, Field

SR = 24000
ROOT = Path(__file__).parent
VOICES_DIR = ROOT / "voices"
HOST = os.environ.get("OMNIVOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("OMNIVOICE_PORT", "8890"))
STEPS = int(os.environ.get("OMNIVOICE_STEPS", "16"))
DEVICE = os.environ.get("OMNIVOICE_DEVICE", "cuda:0")
DEFAULT_VOICE = os.environ.get("OMNIVOICE_DEFAULT_VOICE", "auto")

MEDIA_TYPES = {
    "wav": "audio/wav",
    "flac": "audio/flac",
    "pcm": "audio/pcm",
    "mp3": "audio/mpeg",
    "opus": "audio/ogg",
    "aac": "audio/aac",
}

state: dict = {}
gen_lock = asyncio.Lock()  # one generation at a time on the single GPU


class Voice:
    def __init__(self, name: str, prompt: VoiceClonePrompt, language: str | None, description: str):
        self.name, self.prompt, self.language, self.description = name, prompt, language, description


def load_voices() -> dict[str, Voice]:
    voices: dict[str, Voice] = {}
    for pt in sorted(VOICES_DIR.glob("*.pt")):
        meta_path = pt.with_suffix(".json")
        meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
        voices[pt.stem] = Voice(pt.stem, VoiceClonePrompt.load(str(pt)), meta.get("language"), meta.get("description", ""))
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
    proc = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", *codec, "pipe:1"], input=wav, capture_output=True)
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
    saved = [{"id": v.name, "language": v.language, "description": v.description} for v in state["voices"].values()]
    return {"default": DEFAULT_VOICE, "voices": [{"id": "auto", "language": None, "description": "model-chosen, varies per call"}, *saved]}


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
