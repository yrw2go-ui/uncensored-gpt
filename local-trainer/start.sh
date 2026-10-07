#!/usr/bin/env bash
# Starts the LoRA Studio local trainer on http://127.0.0.1:8676
# Extra args are passed through, e.g. --allow-origin https://my-app.example.com
cd "$(dirname "$0")"
PY=ai-toolkit/venv/bin/python
[ -x "$PY" ] || PY=python3
exec "$PY" server.py --toolkit ai-toolkit "$@"
