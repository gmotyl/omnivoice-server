# omnivoice-server

Local [OmniVoice](https://huggingface.co/k2-fsa/OmniVoice) TTS behind an OpenAI-compatible API on
`127.0.0.1:8890`, with a voice catalog you can extend by cloning a short reference recording.

## Licences

- **Code:** MIT, see [LICENSE](LICENSE).
- **Model weights:** the OmniVoice weights (`k2-fsa/OmniVoice`) are **CC-BY-NC**, so this server is
  for personal, non-commercial use. They are downloaded from Hugging Face on first start and are not
  shipped in this repo.
- **Bundled voices:** see [voices/README.md](voices/README.md) for each voice's source and
  attribution (the voice-bank clips are CC-BY-NC-SA 4.0).

## Fresh machine

Needs an NVIDIA GPU with CUDA, [uv](https://docs.astral.sh/uv/) and `ffmpeg` on `PATH`.

```bash
git clone https://github.com/gmotyl/omnivoice-server.git
cd omnivoice-server
uv sync --frozen                         # Python 3.12, torch 2.8.0+cu128, omnivoice 0.2.1
HF_HUB_OFFLINE=0 ./omnivoicectl start    # first start only: downloads the weights (~3.1 GB)
./omnivoicectl status
```

After the first start, plain `./omnivoicectl start` works offline. If you use the server from
[Pavilio](https://github.com/gmotyl/pavilio), run `pnpm install:speech` in the Pavilio workspace
next: it seeds your custom voices (the ones cloned from Settings → Speech, whose samples the
workspace keeps) into this server's `voices-custom/` through `POST /v1/voices`.

## Run

```bash
./omnivoicectl start|stop|restart|status|log
.venv/bin/python smoke_test.py    # health, voices, every voice + format (needs a running server)
.venv/bin/python -m pytest        # API tests, model mocked
```

`omnivoicectl` uses `HF_HOME` (default `/root/.cache/huggingface`) and `HF_HUB_OFFLINE=1` unless you
set them; the pid goes in `run/`, the log in `logs/server.log`. It pins its own `PATH`/`HOME` and
never blocks, so it can be started from the WSL `[boot] command` in `/etc/wsl.conf`:

```ini
command = /bin/sh -c "...; /path/to/omnivoice-server/omnivoicectl start >/dev/null 2>&1"
```

Env: `OMNIVOICE_HOST` (127.0.0.1), `OMNIVOICE_PORT` (8890), `OMNIVOICE_STEPS` (16),
`OMNIVOICE_DEVICE` (cuda:0), `OMNIVOICE_DEFAULT_VOICE` (auto), `OMNIVOICE_VOICES_DIR` (voices),
`OMNIVOICE_CUSTOM_DIR` (voices-custom). Relative dirs resolve against the repo root.

## Voices: bundled and custom

Each voice is `<name>.pt` (the saved `VoiceClonePrompt`), `<name>.wav` (its reference clip) and
`<name>.json` (its record).

- **Bundled** voices live in `voices/` (`OMNIVOICE_VOICES_DIR`). They are tracked in git and are
  read-only for the API: they can't be replaced or deleted.
- **Custom** voices live in `voices-custom/` (`OMNIVOICE_CUSTOM_DIR`). It is gitignored and is the
  only dir `POST`/`DELETE /v1/voices` write to. A custom voice whose name clashes with a bundled one
  is skipped at load (the bundled one wins).

`auto` is built in (the model picks a voice per call) and is a reserved name.

Bundled voices can also be made offline:

```bash
uv run python make_voice.py pl-ania --language pl --design "female, young adult" --seed 3
uv run python make_voice.py me --language pl --ref clip.wav --ref-text "..."
```

then `./omnivoicectl restart`.

## API

### `POST /v1/audio/speech`

OpenAI-compatible: `input`, `voice`, `response_format` (wav|flac|pcm|mp3|opus|aac), `speed`, plus the
extensions `language` and `num_step`. An unknown voice is a 404.

### `GET /v1/voices`

```json
{
  "default": "auto",
  "voices": [
    {"id": "auto", "source": null, "language": null, "locale": null, "gender": null,
     "label": null, "multilingual": null, "ref_text": null,
     "description": "model-chosen, varies per call"},
    {"id": "pl-female", "source": "bundled", "language": "pl", "locale": "pl-PL",
     "gender": "female", "label": "...", "multilingual": false, "ref_text": "...",
     "description": "..."}
  ]
}
```

`source` is `bundled`, `custom` or `null` (for `auto`). A voice with an older `.json` may have `null`
in any metadata field.

### `POST /v1/voices`

Clones a custom voice from a recording. `multipart/form-data` fields:

| Field          | Required | Notes                                                              |
| -------------- | -------- | ------------------------------------------------------------------ |
| `file`         | yes      | any audio ffmpeg can decode; stored as 24 kHz mono wav             |
| `name`         | yes      | `a-z`, `0-9`, `-`; 1–64 chars; not starting with `-`; not `auto`   |
| `ref_text`     | yes      | the recording's transcript, non-blank                              |
| `locale`       | yes      | e.g. `pl-PL`; `language` is derived from it                        |
| `gender`       | yes      | `male`, `female` or `neutral`                                      |
| `label`        | no       | display name                                                       |
| `multilingual` | no       | `true` or `false` (default `false`)                                |

- **201:** the new voice record (the `GET /v1/voices` shape, `source: "custom"`). Posting an existing
  custom name replaces that voice.
- **400:** invalid or reserved name, blank `ref_text`, bad `locale`/`gender`/`multilingual`, an
  undecodable file, or a cloning failure. `detail` says which.
- **409:** the name belongs to a bundled voice.

### `DELETE /v1/voices/{name}`

- **204:** the custom voice and its files are gone.
- **403:** bundled voice.
- **404:** unknown voice.
- **400:** `auto` (built in).

### `GET /v1/voices/{name}/sample`

The voice's reference clip as `audio/wav`. 404 if the voice is unknown or has no `.wav`.

### `GET /health`

`ok` (model loaded), `device`, `cuda`, `vram_mib`, `num_step`, `load_s`.
