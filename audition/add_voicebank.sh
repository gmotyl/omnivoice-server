#!/bin/sh
# Add voice-bank voices to the picks page: extract (+ similar), render PL+EN samples, rebuild.
#   audition/add_voicebank.sh <name> [<name>…]
set -e
cd "$(dirname "$0")/.."
uv run --no-project --with pyarrow --with numpy python audition/voicebank_pick.py "$@"
HF_HUB_OFFLINE=1 HF_HOME=/root/.cache/huggingface .venv/bin/python audition/render.py --only vb- --langs pl,en --manifest manifest-vb.json 2>&1 | grep -E '^(ok|manifest)'
.venv/bin/python audition/build_page.py /srv/git/prv/projects/projects/tts-providers/mockups/2026-11-03-voicebank-picks.html \
  --manifest manifest-vb.json --catalog /srv/git/prv/pavilio/panel/src/features/speech/openaiVoices.ts \
  --title "Voice bank picks — Polish and English samples"
