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
./omnivoicectl start|stop|restart|status|log|relay-log
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
`OMNIVOICE_CUSTOM_DIR` (voices-custom), `OMNIVOICE_NORMALIZE` (on; `0`, `false` or `off` turns
[text normalisation](#text-normalisation) off). Relative dirs resolve against the repo root.

`start` also starts the browser relay (next section) and `stop` stops both. If something already
answers `/health` on `OMNIVOICE_PORT` without this ctl's pid file (another clone, a hand-started
server), `start` leaves it alone instead of loading a second model. `status` exits with the
server's state (0 healthy, 1 loading, 3 not running) and also prints the relay and `tailscale
serve` state.

## Text normalisation

Before synthesis, `POST /v1/audio/speech` rewrites numbers, decimals, ranges, percentages, units,
dates, money, abbreviations and acronyms into spoken words (`12,5%` → "dwanaście przecinek pięć procent",
`API` → "a pe i"), so the model says them and its duration estimate matches what is said.

- **Scope:** `pl` and `en` only; any other language passes through unchanged. A locale such as
  `pl-PL` is reduced to `pl`.
- **Language:** the request's `language`, else the voice's.
- **Untouched:** bracket tags (`[laughter]`), URLs, paths and identifiers (`OMNIVOICE_STEPS=16`,
  `v1.2.3`).
- **Switch:** on by default; `OMNIVOICE_NORMALIZE=0|false|off` turns it off. It is read at startup,
  so restart the server to change it.

Design: [openspec/changes/text-normalisation/design.md](openspec/changes/text-normalisation/design.md).

## Browser relay over the tailnet

`relay/` is a small Node process ([anytts](https://www.npmjs.com/package/anytts) `anytts/server`)
that lets a browser on another device use this server: it speaks the anytts relay protocol
(`POST /`), lists voices (`GET /voices`) and answers `GET /health` with `{"ok":true}` only while
OmniVoice's own `/health` does. Browsers get CORS headers only for the origins in
`RELAY_ALLOWED_ORIGINS`; any other origin gets a `403` on `POST`. There is no API key: it listens
on loopback and is reachable from other devices only through `tailscale serve`, so only your
tailnet can reach it.

One-time setup (Node >= 22):

```bash
cd relay && npm install && cd ..
cp relay.env.example relay.env               # then edit RELAY_ALLOWED_ORIGINS
tailscale serve status                       # see what is already served
tailscale serve --bg --https=8443 8891       # https://<host>.<tailnet>.ts.net:8443 -> 127.0.0.1:8891
./omnivoicectl restart
./omnivoicectl status         # server, relay, and whether serve maps 8443 to the relay
```

> **Do not use `--https=443` (or a bare `tailscale serve --bg 8891`, which means 443) on SPOCK.**
> HTTPS 443 there already serves the Pavilio panel (`/ -> http://127.0.0.1:3010`); mapping 443 to
> the relay would replace the panel's mapping. Use a free port such as 8443 and set
> `RELAY_SERVE_HTTPS_PORT` if you pick another one. The ctl only reports the mapping and never
> changes it.

The relay runs detached with its pid in `run/relay.pid` and its log in `logs/relay.log`
(`./omnivoicectl relay-log`). A missing node or a missing `relay/node_modules` is reported, and the
server still starts. The ctl treats a pid file as its own only while that pid runs `server.py`
(server, from the repo root) or `server.mjs` (relay, from `relay/`); any other pid file is stale and
removed, so `stop` never signals an unrelated process. `stop` also stops a relay of this checkout
that runs without a pid file, and `status` reports one. Env:

| Variable                | Default                  | Notes                                                        |
| ----------------------- | ------------------------ | ------------------------------------------------------------ |
| `RELAY_HOST`            | `127.0.0.1`              | keep it on loopback; `tailscale serve` does the exposing      |
| `RELAY_PORT`            | `8891`                   | the port `tailscale serve --bg` points at                     |
| `OMNIVOICE_URL`         | `http://127.0.0.1:8890`  | the server (the ctl derives it from `OMNIVOICE_PORT`)         |
| `RELAY_ALLOWED_ORIGINS` | `https://motyl.dev`      | comma list, e.g. `https://motyl.dev,http://localhost:3000`    |
| `RELAY_NODE`            | `node` on the caller's `PATH`, else fnm's default alias | absolute path to a node >= 22; set it for the WSL boot command, whose `PATH` has no fnm |
| `RELAY_SERVE_HTTPS_PORT` | `8443`                  | the tailnet HTTPS port `status` expects `tailscale serve` to map to the relay |

Put them in `relay.env` next to `omnivoicectl` (gitignored; start from the committed
`relay.env.example`). The ctl reads it on every call, so the settings apply however it is started:
the WSL boot command, a terminal, or the Pavilio panel, which runs `omnivoicectl start`/`stop` with
its own start and stop when `PANEL_TTS_SERVER_CTL` points at it and does not pass on
`~/.panel/secrets.env`. The file holds `KEY=VALUE` lines (blank lines and `#` comments skipped,
surrounding quotes stripped); it is parsed, not executed. A variable already set in the calling
environment wins over the file. `start` waits for neither process, so it returns at once.

Browsers on a public page (`https://motyl.dev`) reaching a tailnet host send a Private Network
Access preflight; the relay answers it with `Access-Control-Allow-Private-Network: true` for an
allowed origin.

Check from the phone (on the tailnet): open `https://<host>.<tailnet>.ts.net:8443/health` in its
browser; `{"ok":true}` means relay and server are both up. From SPOCK itself:

```bash
curl -s -H 'Origin: https://motyl.dev' http://127.0.0.1:8891/health
```

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
