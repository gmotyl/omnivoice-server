# platform-support

One repo and one install/run flow on Linux/WSL with CUDA (the primary host, SPOCK) and on macOS
(Apple Silicon, CPU).

### Requirement: Frozen install on both platforms
`uv sync --frozen` installs a working environment on Linux (CUDA torch) and on macOS (PyPI torch)
from the same `pyproject.toml` and `uv.lock`.

#### Scenario: Linux keeps the CUDA wheels
- **WHEN** `uv sync --frozen` runs from an empty `.venv` on SPOCK
- **THEN** `torch==2.8.0+cu128` and `torchaudio==2.8.0+cu128` are installed from the `pytorch-cu128` index and `python -c "import torch; print(torch.cuda.is_available())"` prints `True`

#### Scenario: macOS resolves PyPI torch
- **WHEN** `uv sync --frozen` runs from an empty `.venv` on the MacBook
- **THEN** it succeeds and installs `torch==2.8.0` and `torchaudio==2.8.0` from PyPI (no `+cu128` suffix)

### Requirement: Device default
When `OMNIVOICE_DEVICE` is unset or empty, the server uses `cuda:0` if CUDA is available and `cpu` otherwise; it never selects `mps` on its own.

#### Scenario: CUDA host
- **WHEN** the server starts on SPOCK without `OMNIVOICE_DEVICE`
- **THEN** `/health` reports `device: "cuda:0"` and `cuda: true`

#### Scenario: No CUDA
- **WHEN** the server starts on the MacBook without `OMNIVOICE_DEVICE`
- **THEN** `/health` reports `device: "cpu"` and `cuda: false`

#### Scenario: Explicit device wins
- **WHEN** `OMNIVOICE_DEVICE` is set (for example `cpu` on SPOCK, or `mps` on the mac)
- **THEN** the server uses that value verbatim

### Requirement: Step default
When `OMNIVOICE_STEPS` is unset, the server uses 16 steps on a cuda device and 8 on any other device; an explicit value always wins.

#### Scenario: CUDA default
- **WHEN** the device is `cuda:0` and `OMNIVOICE_STEPS` is unset
- **THEN** `/health` reports `num_step: 16`

#### Scenario: CPU default
- **WHEN** the device is `cpu` and `OMNIVOICE_STEPS` is unset
- **THEN** `/health` reports `num_step: 8`

#### Scenario: Explicit steps win
- **WHEN** `OMNIVOICE_STEPS=12` is set on either device
- **THEN** `/health` reports `num_step: 12`

### Requirement: Portable control script
`omnivoicectl start|stop|restart|status` works on Linux and on macOS, and on Linux behaves exactly as before.

#### Scenario: Detached start without setsid
- **WHEN** `./omnivoicectl start` runs on macOS (no `setsid`)
- **THEN** the server, relay and adapter start in their own session, `run/*.pid` hold their real pids, and the ctl returns at once

#### Scenario: Process identity without /proc
- **WHEN** `./omnivoicectl status` and then `stop` run on macOS after `start`
- **THEN** `status` reports each process as running with its pid file (not "stale"), and `stop` terminates all three and removes the pid files

#### Scenario: Unrelated processes are never claimed
- **WHEN** another process runs from the ctl's directory with a command line that is not exactly `<node> server.mjs` or `<python> -W ignore server.py` (for example `node other.mjs server.mjs`, `deno server.mjs`, or `server.mjs` inside a quoted argument)
- **THEN** the ctl does not treat it as its own: `status` does not report it and `stop` never signals it

#### Scenario: Old bash
- **WHEN** the ctl is started by bash older than 4.4 (stock macOS `/bin/bash`)
- **THEN** it re-execs itself under a Homebrew bash ≥ 4.4, or, when none exists, exits 2 with `omnivoicectl needs bash >= 4.4 (macOS: brew install bash)`

#### Scenario: Homebrew tools without a login PATH
- **WHEN** the panel starts the ctl on the mac with a `PATH` lacking `/opt/homebrew/bin`
- **THEN** the server finds `ffmpeg` and an `mp3` request answers 200

#### Scenario: SPOCK unchanged
- **WHEN** `./omnivoicectl restart` and `status` run on SPOCK
- **THEN** the processes are started with `setsid`, identified through `/proc`, `PATH` gains no new entries, and `status` reports the server healthy (exit 0)
