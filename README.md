# omnivoice-server

Local [OmniVoice](https://huggingface.co/k2-fsa/OmniVoice) TTS behind an OpenAI-compatible API on
`127.0.0.1:8890`, with a voice catalog you can extend by cloning a short reference recording.

It comes with everything needed to read web pages aloud in your own voice catalog:

- **the server** (`server.py`, port 8890): OmniVoice on your GPU;
- **the relay** (`relay/`, port 8891): a small Node process speaking the anytts protocol;
- **the Narrate / Read Aloud adapter** (`narrate/`, port 8892): an OpenAI-compatible
  `/v1/audio/speech` endpoint in front of the relay;
- **the reader extension** (`extension/`): a Chrome / Edge extension that reads the open page
  aloud through the adapter, highlighting each sentence.

`./omnivoicectl start` starts the server, the relay and the adapter together, all on loopback.
Reaching them from other devices is [optional](#using-it-from-other-devices-optional-tailscale).

## Quick start: read web pages aloud

### 1. Requirements

- An NVIDIA GPU with CUDA.
- [uv](https://docs.astral.sh/uv/) and `ffmpeg` on `PATH`.
- Node 22+ with npm (relay and adapter), and [pnpm](https://pnpm.io/) to build the extension.
- Chrome or Edge 116+.

### 2. Get the code and install the dependencies

```bash
git clone https://github.com/gmotyl/omnivoice-server.git
cd omnivoice-server
uv sync --frozen                     # Python 3.12, torch 2.8.0+cu128, omnivoice 0.2.1
(cd relay && npm install)
(cd narrate && npm install)
```

The extension talks to the narrate adapter, and the adapter sits in front of the relay, which
calls the server: you need both `relay/` and `narrate/` installed, not only the server.

`omnivoicectl` keeps the model in `$HF_HOME` and defaults it to `/root/.cache/huggingface`. If
you are not root, or want another cache, export it before every `omnivoicectl` call (it is not
read from `relay.env`):

```bash
export HF_HOME="$HOME/.cache/huggingface"
```

### 3. Start the server

The first start downloads the model weights (about 3.1 GB), so allow network access once:

```bash
HF_HUB_OFFLINE=0 ./omnivoicectl start
./omnivoicectl status                # repeat until the server reports healthy (exit code 0)
```

`start` returns at once; loading the model takes a while (longer on the first start). After that,
plain `./omnivoicectl start` works offline. Check the adapter, which is what the extension uses:

```bash
curl -s http://127.0.0.1:8892/health            # {"ok":true}
curl -s http://127.0.0.1:8892/v1/audio/voices   # {"voices":["auto", ...]}
```

### 4. Build and load the extension

```bash
cd extension
pnpm install
pnpm build
```

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge) and turn on
   **Developer mode**.
2. **Load unpacked** and pick the `extension/` folder (not `dist/`).
3. Open the extension's **Options** (right-click the toolbar icon → Options) and press
   **Test connection**: it should say "Connection OK" with the default
   `http://localhost:8892/v1`. Pick a voice and **Save**.
4. Open an article and click the toolbar icon (or press `Alt+Shift+R`). The page is read aloud,
   with the current sentence highlighted.

**WSL:** if the server runs in WSL and the browser on Windows, load the folder through its
`\\wsl$\<distro>\…\omnivoice-server\extension` path. WSL forwards `localhost` to Windows, so the
default `http://localhost:8892/v1` reaches the adapter.

Usage, options and troubleshooting: [extension/README.md](extension/README.md).

## Licences

- **Code:** MIT, see [LICENSE](LICENSE).
- **Model weights:** the OmniVoice weights (`k2-fsa/OmniVoice`) are **CC-BY-NC**, so this server is
  for personal, non-commercial use. They are downloaded from Hugging Face on first start and are not
  shipped in this repo.
- **Bundled voices:** see [voices/README.md](voices/README.md) for each voice's source and
  attribution (the voice-bank clips are CC-BY-NC-SA 4.0).

## Run

```bash
./omnivoicectl start|stop|restart|status|log|relay-log|narrate-log
.venv/bin/python smoke_test.py    # health, voices, every voice + format (needs a running server)
.venv/bin/python -m pytest        # API tests, model mocked
```

`omnivoicectl` uses `HF_HOME` (default `/root/.cache/huggingface`; set it to your own Hugging Face
cache) and `HF_HUB_OFFLINE=1` unless you set them; the pid goes in `run/`, the log in
`logs/server.log`.

Env: `OMNIVOICE_HOST` (127.0.0.1), `OMNIVOICE_PORT` (8890), `OMNIVOICE_STEPS` (16),
`OMNIVOICE_DEVICE` (cuda:0), `OMNIVOICE_DEFAULT_VOICE` (auto), `OMNIVOICE_VOICES_DIR` (voices),
`OMNIVOICE_CUSTOM_DIR` (voices-custom), `OMNIVOICE_NORMALIZE` (on; `0`, `false` or `off` turns
[text normalisation](#text-normalisation) off), `OMNIVOICE_SPEED` (0.9; the speed used when a
request sends none — at 1.0 several voices drop words because the duration estimate is too
tight). Relative dirs resolve against the repo root.

`start` also starts the [relay](#browser-relay) and the
[adapter](#narrate--read-aloud-adapter), and `stop` stops all three. If something already answers
`/health` on `OMNIVOICE_PORT` without this ctl's pid file (another clone, a hand-started server),
`start` leaves it alone instead of loading a second model. `status` exits with the server's state
(0 healthy, 1 loading, 3 not running) and also prints the relay and adapter state and their
`tailscale serve` mappings (or that Tailscale is not installed, which is fine for local use).

### Start at boot

`omnivoicectl` pins its own `PATH`/`HOME` and never blocks, so it can run from a boot hook with a
near-empty environment. On WSL, for example, from the `[boot] command` in `/etc/wsl.conf`:

```ini
[boot]
command = /bin/sh -c "/path/to/omnivoice-server/omnivoicectl start >/dev/null 2>&1"
```

Such a hook usually has no version manager (fnm, nvm) on its `PATH`: set `RELAY_NODE` in
`relay.env` to an absolute node >= 22 path, and `HF_HOME` in the command if you use a non-default
cache.

## Text normalisation

Before synthesis, `POST /v1/audio/speech` rewrites numbers, decimals, ranges, percentages, units,
dates, money and abbreviations into spoken words (`12,5%` → "dwanaście przecinek pięć procent"),
so the model says them and its duration estimate matches what is said. All-caps acronyms (`API`,
`GPU`) are left as written: OmniVoice pronounces them correctly by itself.

- **Scope:** `pl` and `en` only; any other language passes through unchanged. A locale such as
  `pl-PL` is reduced to `pl`.
- **Language:** the request's `language`, else the voice's.
- **Untouched:** bracket tags (`[laughter]`), URLs, paths and identifiers (`OMNIVOICE_STEPS=16`,
  `v1.2.3`).
- **Switch:** on by default; `OMNIVOICE_NORMALIZE=0|false|off` turns it off. It is read at startup,
  so restart the server to change it.

Design: [openspec/changes/archive/2026-11-05-text-normalisation/design.md](openspec/changes/archive/2026-11-05-text-normalisation/design.md).

## Browser relay

`relay/` is a small Node process ([anytts](https://www.npmjs.com/package/anytts) `anytts/server`)
that lets a browser page use this server: it speaks the anytts relay protocol (`POST /`), lists
voices (`GET /voices`) and answers `GET /health` with `{"ok":true}` only while OmniVoice's own
`/health` does. The narrate adapter (next section) calls it too. Browsers get CORS headers only for
the origins in `RELAY_ALLOWED_ORIGINS`; any other origin gets a `403` on `POST`. There is no API
key: it listens on loopback only.

Setup (Node >= 22):

```bash
cd relay && npm install && cd ..
cp relay.env.example relay.env               # optional; then edit RELAY_ALLOWED_ORIGINS
./omnivoicectl restart
```

The relay runs detached with its pid in `run/relay.pid` and its log in `logs/relay.log`
(`./omnivoicectl relay-log`). A missing node or a missing `relay/node_modules` is reported, and the
server still starts. The ctl treats a pid file as its own only while that pid runs `server.py`
(server, from the repo root) or `server.mjs` (relay, from `relay/`); any other pid file is stale and
removed, so `stop` never signals an unrelated process. `stop` also stops a relay of this checkout
that runs without a pid file, and `status` reports one. Env:

| Variable                | Default                  | Notes                                                        |
| ----------------------- | ------------------------ | ------------------------------------------------------------ |
| `RELAY_HOST`            | `127.0.0.1`              | keep it on loopback                                           |
| `RELAY_PORT`            | `8891`                   |                                                               |
| `OMNIVOICE_URL`         | `http://127.0.0.1:8890`  | the server (the ctl derives it from `OMNIVOICE_PORT`)         |
| `RELAY_ALLOWED_ORIGINS` | `https://motyl.dev`      | comma list of browser origins, e.g. `https://example.com,http://localhost:3000`; set your own (the default is the author's site) |
| `RELAY_NODE`            | `node` on the caller's `PATH`, else fnm's default alias | absolute path to a node >= 22; set it when the ctl runs with a minimal `PATH` (a boot hook) |
| `RELAY_SERVE_HTTPS_PORT` | `8443`                  | only for `status`: the tailnet HTTPS port it expects `tailscale serve` to map to the relay |

Put them in `relay.env` next to `omnivoicectl` (gitignored; start from the committed
`relay.env.example`). The ctl reads it on every call, so the settings apply however it is started:
a boot hook, a terminal, or another program that runs `omnivoicectl start`/`stop` without your
shell's environment. The file holds `KEY=VALUE` lines (blank lines and `#` comments skipped,
surrounding quotes stripped); it is parsed, not executed. A variable already set in the calling
environment wins over the file. `start` waits for neither process, so it returns at once.

The reader extension does not call the relay directly and needs no `RELAY_ALLOWED_ORIGINS` entry.

Check it locally:

```bash
curl -s http://127.0.0.1:8891/health   # {"ok":true} while relay and server are up
```

## Narrate / Read Aloud adapter

`narrate/` is a second small Node process in front of the relay for browser extensions that speak
their own protocol instead of anytts:

- **Reader extension** (`extension/`) and **Read Aloud** and other OpenAI-compatible clients:
  `GET /v1/models`, `GET /v1/audio/voices`, `POST /v1/audio/speech`.
- **Narrate** (Chrome extension, reads the open article): `GET /config` lists voices,
  `WS /stream?voice=<id>` streams PCM16 mono 24 kHz, `POST /download` returns an mp3.

It splits text into sentence-aligned pieces, asks the relay for each (prefetching one ahead) and
answers `GET /health` with `{"ok":true}` while it runs. It allows any origin (CORS `*`): like the
relay it listens on loopback only.

Setup:

```bash
cd narrate && npm install && cd ..
./omnivoicectl start                         # server, then relay, then the adapter
./omnivoicectl status                        # includes the adapter
```

`start`, `stop`, `status` and the pid-file rules work for the adapter exactly as for the relay
(`run/narrate.pid`, `logs/narrate.log`, `./omnivoicectl narrate-log`); it runs on the same node
(`RELAY_NODE`). When something else already answers on its port, `start` leaves it alone. Env, also
read from `relay.env`:

| Variable                   | Default     | Notes                                                       |
| -------------------------- | ----------- | ----------------------------------------------------------- |
| `NARRATE_HOST`             | `127.0.0.1` | keep it on loopback                                         |
| `NARRATE_PORT`             | `8892`      | the reader extension's default base URL uses it              |
| `NARRATE_SERVE_HTTPS_PORT` | `8444`      | only for `status`: the tailnet HTTPS port it expects to map to the adapter |

## Reader extension

`extension/` is our own Chrome / Edge extension: it reads the page's article or the selection
aloud through the adapter above (`http://localhost:8892/v1` by default), highlighting each sentence
in place. Setup: [Quick start](#quick-start-read-web-pages-aloud); usage and options:
[extension/README.md](extension/README.md).

## Using it from other devices (optional, Tailscale)

Everything above works on one machine with no extra setup. To use the relay or the adapter from a
phone or another computer, expose them on your [tailnet](https://tailscale.com/) with
`tailscale serve`; nothing else is reachable from outside.

```bash
tailscale serve status                       # see what is already served
tailscale serve --bg --https=8443 8891       # https://<host>.<tailnet>.ts.net:8443 -> relay
tailscale serve --bg --https=8444 8892       # https://<host>.<tailnet>.ts.net:8444 -> adapter
./omnivoicectl status                        # reports both mappings
```

`omnivoicectl` only reports these mappings and never changes them. If HTTPS 443 or the ports above
already serve something else on the host, pick free ports (a bare `tailscale serve --bg 8891`
means 443 and would replace an existing 443 mapping) and set `RELAY_SERVE_HTTPS_PORT` /
`NARRATE_SERVE_HTTPS_PORT` so `status` checks the right ones.

A browser page served from a public origin (say `https://example.com`) that calls the relay on a
tailnet host sends a Private Network Access preflight; the relay answers it with
`Access-Control-Allow-Private-Network: true` for an origin in `RELAY_ALLOWED_ORIGINS`.

### Tailnet URLs

With both mappings in place, any device on the tailnet uses these (`<host>.<tailnet>.ts.net` is
the machine's MagicDNS name, see `tailscale status`):

| Client                                   | URL to enter                                  |
| ---------------------------------------- | --------------------------------------------- |
| anytts in a browser page                 | `https://<host>.<tailnet>.ts.net:8443` (relay; the page's origin must be in `RELAY_ALLOWED_ORIGINS`) |
| Reader extension, "Server base URL"      | `https://<host>.<tailnet>.ts.net:8444/v1` (Save asks for the host permission) |
| Narrate (Chrome), "Server URL"           | `https://<host>.<tailnet>.ts.net:8444`        |
| Read Aloud / OpenAI-compatible, base URL | `https://<host>.<tailnet>.ts.net:8444/v1`     |
| Health check                             | `https://<host>.<tailnet>.ts.net:8443/health` (relay + server), `:8444/health` (adapter) |

Check from another device: open `https://<host>.<tailnet>.ts.net:8443/health` in its browser;
`{"ok":true}` means relay and server are both up. On the host itself the tailnet URL works too.

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
