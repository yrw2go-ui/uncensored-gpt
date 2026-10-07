#!/usr/bin/env bash
# Installs ostris/ai-toolkit next to this script for LoRA Studio local training.
# Needs: git, Python 3.10+ (3.12 recommended), an NVIDIA GPU with recent drivers.
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"
TORCH_INDEX="${TORCH_INDEX:-https://download.pytorch.org/whl/cu130}"

if [ ! -d ai-toolkit ]; then
  git clone --depth 1 https://github.com/ostris/ai-toolkit.git
fi
cd ai-toolkit
git submodule update --init --recursive
[ -d venv ] || "$PYTHON" -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install --no-cache-dir torch torchvision torchaudio --index-url "$TORCH_INDEX"
pip install -r requirements.txt

echo
echo "Done. Start the trainer with: ./start.sh"
echo "For FLUX.1 [dev], also run: ai-toolkit/venv/bin/huggingface-cli login"
