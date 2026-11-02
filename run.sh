#!/usr/bin/env bash
# Start the local OmniVoice TTS server (OpenAI-compatible) on 127.0.0.1:8890.
set -euo pipefail
cd "$(dirname "$0")"
exec uv run --frozen python -W ignore server.py
