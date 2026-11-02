# omnivoice-server

Local [OmniVoice](https://huggingface.co/k2-fsa/OmniVoice) TTS behind an OpenAI-compatible API on `127.0.0.1:8890`.
Weights are CC-BY-NC — personal use only. Findings: [OmniVoice local spike](/project/tts-providers/memo?file=tts-providers%2Fmemo%2F2026-11-02_1831_omnivoice_local_spike.md)

API: `POST /v1/audio/speech` (`input`, `voice`, `response_format` wav|flac|pcm|mp3|opus|aac, `speed`,
extensions `language`, `num_step`), `GET /v1/voices`, `GET /health`.
Env: `OMNIVOICE_PORT`, `OMNIVOICE_HOST`, `OMNIVOICE_STEPS`, `OMNIVOICE_DEFAULT_VOICE`, `OMNIVOICE_DEVICE`.

## Run

```bash
uv sync --frozen                  # once: Python 3.12, torch 2.8.0+cu128, omnivoice 0.2.1
./omnivoicectl start|stop|restart|status|log
.venv/bin/python smoke_test.py    # health, voices, every voice + format
```

`omnivoicectl` runs as root with root's HF cache (`/root/.cache/huggingface`, 3.1 GB) and
`HF_HUB_OFFLINE=1`; pid in `run/`, log in `logs/server.log`. It pins its own PATH/HOME, so it works
from the WSL `[boot] command` in `/etc/wsl.conf`:

```ini
command = /bin/sh -c "...; /srv/git/prv/omnivoice-server/omnivoicectl start >/dev/null 2>&1"
```

## Voices

Saved clone prompts in `voices/` (`pl-male`, `pl-female`, `en-male`, `en-female`, bootstrapped
from voice design, seed 0). New one:

```bash
uv run python make_voice.py pl-ania --language pl --design "female, young adult" --seed 3
uv run python make_voice.py me --language pl --ref clip.wav --ref-text "..."
```

Then `./omnivoicectl restart`.
