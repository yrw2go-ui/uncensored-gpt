# LoRA Studio local trainer

Train LoRAs on your own PC from LoRA Studio ("Train on: This PC"), using
[ostris/ai-toolkit](https://github.com/ostris/ai-toolkit). After the base model
has been downloaded once, training works with no internet connection.

## Requirements

- NVIDIA GPU: 12GB+ VRAM for SDXL, 16GB+ for Wan 2.1 1.3B, 24GB for FLUX and Qwen-Image
- Linux or Windows, recent NVIDIA drivers
- Python 3.10+ (3.12 recommended) and git

## Install

```bash
# Linux
./setup.sh
# Windows
setup.bat
```

This clones ai-toolkit into `local-trainer/ai-toolkit` and installs PyTorch and
its requirements into a virtualenv there. Set `TORCH_INDEX` to pick a different
CUDA build (default `https://download.pytorch.org/whl/cu130`).

FLUX.1 [dev] is gated: accept its license on Hugging Face, then run
`huggingface-cli login` from the ai-toolkit virtualenv.

## Run

```bash
./start.sh        # Linux
start.bat         # Windows
```

The trainer listens on `http://127.0.0.1:8676`. Open LoRA Studio, choose
**This PC**, and press **Download** next to a base model while you're online.
Once it shows as downloaded, training uses only the local copy.

Jobs, datasets, configs, logs and `.safetensors` outputs are stored in
`~/.lora-studio/jobs/<id>/` (change with `--home`).

## Using it from a hosted copy of the app

Only pages served from `localhost` or the desktop app may talk to the trainer,
so other websites can't start jobs on your GPU. To use a hosted copy, allow its
origin explicitly:

```bash
./start.sh --allow-origin https://your-app.example.com
```

## Running a job by hand

Each job's ai-toolkit config is saved as `~/.lora-studio/jobs/<id>/config.yaml`,
so you can re-run or tweak it directly with `python run.py <config.yaml>` inside
the ai-toolkit folder.
