#!/usr/bin/env python3
"""LoRA Studio local trainer.

A small HTTP server that lets LoRA Studio train LoRAs on this PC with
ostris/ai-toolkit. Standard library only, so it runs with any Python 3.10+.

    python server.py --toolkit ./ai-toolkit

Only browser pages served from localhost (or origins passed with
--allow-origin) may call it, so other websites can't start jobs on your GPU.
"""

import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

VERSION = "1.0"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv"}
MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024

# Base models LoRA Studio can train locally. "model" and "sample" are merged
# into the ai-toolkit config; they follow ai-toolkit's config/examples.
MODELS = {
    "flux-dev": {
        "name": "FLUX.1 [dev]",
        "repo": "black-forest-labs/FLUX.1-dev",
        "media": "image",
        "vram": 24,
        "gated": True,
        "note": "Best quality. Needs a Hugging Face token with access to FLUX.1-dev for the first download.",
        "model": {"is_flux": True, "quantize": True},
        "train": {"noise_scheduler": "flowmatch", "lr": 1e-4},
        "sample": {"sampler": "flowmatch", "guidance_scale": 4, "sample_steps": 20},
        "resolution": [512, 768, 1024],
        "rank": 16,
    },
    "flux-schnell": {
        "name": "FLUX.1 [schnell]",
        "repo": "black-forest-labs/FLUX.1-schnell",
        "extra_repos": ["ostris/FLUX.1-schnell-training-adapter"],
        "media": "image",
        "vram": 24,
        "gated": False,
        "note": "Apache-licensed FLUX; no Hugging Face account needed.",
        "model": {
            "is_flux": True,
            "quantize": True,
            "assistant_lora_path": "ostris/FLUX.1-schnell-training-adapter",
        },
        "train": {"noise_scheduler": "flowmatch", "lr": 1e-4},
        "sample": {"sampler": "flowmatch", "guidance_scale": 1, "sample_steps": 4},
        "resolution": [512, 768, 1024],
        "rank": 16,
    },
    "sdxl": {
        "name": "Stable Diffusion XL",
        "repo": "stabilityai/stable-diffusion-xl-base-1.0",
        "media": "image",
        "vram": 12,
        "gated": False,
        "note": "Runs on 12GB GPUs. Huge ecosystem of SDXL tools.",
        "model": {"is_xl": True},
        "train": {"noise_scheduler": "ddpm", "lr": 1e-4},
        "sample": {"sampler": "ddpm", "guidance_scale": 7, "sample_steps": 30},
        "resolution": [1024],
        "rank": 16,
    },
    "qwen-image": {
        "name": "Qwen-Image",
        "repo": "Qwen/Qwen-Image",
        "extra_repos": ["ostris/accuracy_recovery_adapters"],
        "media": "image",
        "vram": 24,
        "gated": False,
        "note": "Great at illustration and text in images.",
        "model": {
            "arch": "qwen_image",
            "quantize": True,
            "qtype": "uint3|ostris/accuracy_recovery_adapters/qwen_image_torchao_uint3.safetensors",
            "quantize_te": True,
            "qtype_te": "qfloat8",
            "low_vram": True,
        },
        "train": {
            "noise_scheduler": "flowmatch",
            "lr": 1e-4,
            "cache_text_embeddings": True,
        },
        "sample": {"sampler": "flowmatch", "guidance_scale": 3, "sample_steps": 25},
        "resolution": [512, 768, 1024],
        "rank": 16,
    },
    "wan21-1b": {
        "name": "Wan 2.1 1.3B (video)",
        "repo": "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
        "media": "video",
        "vram": 16,
        "gated": False,
        "note": "Text-to-video LoRA. Train on short clips or images.",
        "model": {"arch": "wan21", "quantize_te": True},
        "train": {
            "noise_scheduler": "flowmatch",
            "timestep_type": "sigmoid",
            "lr": 1e-4,
        },
        "sample": {
            "sampler": "flowmatch",
            "guidance_scale": 5,
            "sample_steps": 30,
            "width": 832,
            "height": 480,
            "num_frames": 40,
            "fps": 15,
        },
        "resolution": [632],
        "rank": 32,
    },
}


# ---------------------------------------------------------------- helpers


def to_yaml(value, indent=0):
    """Minimal YAML emitter (dicts, lists, scalars). JSON-quoted strings are
    valid YAML, so no PyYAML dependency is needed."""
    pad = "  " * indent
    if isinstance(value, dict):
        lines = []
        for k, v in value.items():
            if isinstance(v, (dict, list)) and v:
                lines.append(f"{pad}{k}:")
                lines.append(to_yaml(v, indent + 1))
            else:
                lines.append(f"{pad}{k}: {to_yaml(v)}")
        return "\n".join(lines)
    if isinstance(value, list):
        if not value:
            return "[]"
        lines = []
        for v in value:
            if isinstance(v, dict):
                inner = to_yaml(v, indent + 1).lstrip()
                lines.append(f"{pad}- {inner}")
            else:
                lines.append(f"{pad}- {to_yaml(v)}")
        return "\n".join(lines)
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, (int, float)):
        return repr(value)
    return json.dumps(str(value))


def slugify(text):
    slug = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return slug[:40] or "lora"


def toolkit_python(toolkit: Path):
    for candidate in (
        toolkit / "venv" / "bin" / "python",
        toolkit / "venv" / "Scripts" / "python.exe",
        toolkit / ".venv" / "bin" / "python",
        toolkit / ".venv" / "Scripts" / "python.exe",
    ):
        if candidate.exists():
            return str(candidate)
    return sys.executable


def gpu_info():
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        gpus = []
        for line in out.splitlines():
            name, mem = [p.strip() for p in line.split(",")]
            gpus.append({"name": name, "vram_gb": round(int(mem) / 1024)})
        return gpus
    except Exception:
        return []


# ---------------------------------------------------------------- state


class Store:
    def __init__(self, toolkit: Path, home: Path):
        self.toolkit = toolkit
        self.python = toolkit_python(toolkit)
        self.home = home
        self.jobs_dir = home / "jobs"
        self.jobs_dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.jobs = {}
        self.queue = []
        self.current = None  # (job_id, Popen)
        self.downloads = {}  # model id -> {"status", "log"}
        self.cached = {}  # model id -> bool
        self.gpus = gpu_info()

        for meta in self.jobs_dir.glob("*/job.json"):
            try:
                job = json.loads(meta.read_text())
            except Exception:
                continue
            if job["status"] in ("queued", "processing", "starting"):
                job["status"] = "failed"
                job["error"] = "Trainer was restarted while this job was running"
            self.jobs[job["id"]] = job
            self.save(job)

        threading.Thread(target=self.worker, daemon=True).start()
        threading.Thread(target=self.refresh_cache, daemon=True).start()

    # -- jobs

    def job_dir(self, job_id):
        return self.jobs_dir / job_id

    def save(self, job):
        path = self.job_dir(job["id"]) / "job.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(job, indent=2))
        tmp.replace(path)

    def create_job(self, settings):
        model_id = settings.get("model")
        if model_id not in MODELS:
            raise ValueError(f"unknown model: {model_id}")
        job_id = uuid.uuid4().hex[:12]
        steps = int(settings.get("steps") or 1000)
        job = {
            "id": job_id,
            "name": str(settings.get("name") or "My LoRA")[:80],
            "slug": f"{slugify(settings.get('name') or 'lora')}_{job_id[:6]}",
            "model": model_id,
            "trigger_word": str(settings.get("trigger_word") or "TOK")[:60],
            "default_caption": str(
                settings.get("default_caption") or "a photo of [trigger]"
            ),
            "steps": max(10, min(steps, 20000)),
            "rank": int(settings.get("rank") or MODELS[model_id]["rank"]),
            "lr": float(settings.get("lr") or MODELS[model_id]["train"]["lr"]),
            "sample_prompts": [
                str(p) for p in (settings.get("sample_prompts") or []) if str(p).strip()
            ][:6],
            "status": "uploading",
            "step": 0,
            "created_at": time.time(),
            "error": None,
        }
        with self.lock:
            self.jobs[job_id] = job
            self.save(job)
        return job

    def receive_dataset(self, job_id, data: bytes):
        job = self.jobs[job_id]
        dataset = self.job_dir(job_id) / "dataset"
        if dataset.exists():
            shutil.rmtree(dataset)
        dataset.mkdir(parents=True)

        media = 0
        has_video = False
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for info in zf.infolist():
                name = Path(info.filename).name  # flatten, drops any "../"
                ext = Path(name).suffix.lower()
                if info.is_dir() or not name or name.startswith("."):
                    continue
                if ext not in IMAGE_EXTS | VIDEO_EXTS | {".txt"}:
                    continue
                (dataset / name).write_bytes(zf.read(info))
                if ext in IMAGE_EXTS | VIDEO_EXTS:
                    media += 1
                    has_video = has_video or ext in VIDEO_EXTS

        if media == 0:
            raise ValueError("dataset contains no images or videos")

        # files without a caption get the LoRA type's default caption
        for f in dataset.iterdir():
            if f.suffix.lower() in IMAGE_EXTS | VIDEO_EXTS:
                caption = f.with_suffix(".txt")
                if not caption.exists():
                    caption.write_text(job["default_caption"])

        job["file_count"] = media
        job["has_video"] = has_video
        self.write_config(job)
        with self.lock:
            job["status"] = "queued"
            self.save(job)
            self.queue.append(job_id)

    def write_config(self, job):
        preset = MODELS[job["model"]]
        out_dir = self.job_dir(job["id"]) / "output"
        dataset = {
            "folder_path": str(self.job_dir(job["id"]) / "dataset"),
            "caption_ext": "txt",
            "caption_dropout_rate": 0.05,
            "shuffle_tokens": False,
            "cache_latents_to_disk": True,
            "resolution": preset["resolution"],
        }
        if job.get("has_video"):
            dataset["num_frames"] = 33
        prompts = job["sample_prompts"] or [job["default_caption"]]
        sample = {
            "sample_every": max(50, job["steps"] // 4),
            "sample_start_step": 0,
            "width": 1024,
            "height": 1024,
            "prompts": prompts,
            "neg": "",
            "seed": 42,
            "walk_seed": True,
            **preset["sample"],
        }
        config = {
            "job": "extension",
            "config": {
                "name": job["slug"],
                "process": [
                    {
                        "type": "sd_trainer",
                        "training_folder": str(out_dir),
                        "device": "cuda:0",
                        "trigger_word": job["trigger_word"],
                        "network": {
                            "type": "lora",
                            "linear": job["rank"],
                            "linear_alpha": job["rank"],
                        },
                        "save": {
                            "dtype": "float16",
                            "save_every": max(50, job["steps"] // 4),
                            "max_step_saves_to_keep": 4,
                            "push_to_hub": False,
                        },
                        "datasets": [dataset],
                        "train": {
                            "batch_size": 1,
                            "steps": job["steps"],
                            "gradient_accumulation_steps": 1,
                            "train_unet": True,
                            "train_text_encoder": False,
                            "gradient_checkpointing": True,
                            "optimizer": "adamw8bit",
                            "dtype": "bf16",
                            **preset["train"],
                            "lr": job["lr"],
                        },
                        "model": {"name_or_path": preset["repo"], **preset["model"]},
                        "sample": sample,
                    }
                ],
            },
            "meta": {"name": "[name]", "version": "1.0"},
        }
        (self.job_dir(job["id"]) / "config.yaml").write_text(to_yaml(config) + "\n")

    def cancel(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                return
            if job_id in self.queue:
                self.queue.remove(job_id)
                job["status"] = "canceled"
                self.save(job)
            elif self.current and self.current[0] == job_id:
                job["status"] = "canceled"
                self.save(job)
                self.current[1].terminate()

    def delete(self, job_id):
        self.cancel(job_id)
        with self.lock:
            self.jobs.pop(job_id, None)
        shutil.rmtree(self.job_dir(job_id), ignore_errors=True)

    def worker(self):
        while True:
            job_id = None
            with self.lock:
                if self.current is None and self.queue:
                    job_id = self.queue.pop(0)
            if job_id:
                self.run(job_id)
            else:
                time.sleep(1)

    def run(self, job_id):
        job = self.jobs[job_id]
        log_path = self.job_dir(job_id) / "train.log"
        env = dict(os.environ)
        env["PYTHONUNBUFFERED"] = "1"
        # if the base model is already downloaded, never touch the network
        if self.cached.get(job["model"]):
            env["HF_HUB_OFFLINE"] = "1"
        # tqdm lines look like "name:  12%|###   | 250/2000 [01:02<...]"; other
        # bars (latent caching etc.) are told apart by their total
        progress = re.compile(r"(\d+)/(\d+) \[")

        try:
            proc = subprocess.Popen(
                [self.python, "run.py", str(self.job_dir(job_id) / "config.yaml")],
                cwd=str(self.toolkit),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
            )
        except Exception as e:
            job.update(status="failed", error=f"Could not start ai-toolkit: {e}")
            self.save(job)
            return

        with self.lock:
            self.current = (job_id, proc)
            job.update(status="processing", started_at=time.time())
            self.save(job)

        tail = []
        buf = b""
        last_save = 0.0
        with open(log_path, "ab") as log:
            while True:
                chunk = proc.stdout.read1(4096) if hasattr(proc.stdout, "read1") else proc.stdout.read(4096)
                if not chunk:
                    break
                log.write(chunk)
                buf += chunk
                # tqdm redraws with \r, so treat it as a line break
                *lines, buf = re.split(rb"[\r\n]", buf)
                for raw in lines:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line:
                        continue
                    m = progress.search(line)
                    if m and int(m.group(2)) == job["steps"]:
                        job["step"] = int(m.group(1))
                    if m:
                        if tail and progress.search(tail[-1]):
                            tail[-1] = line
                            continue
                    tail.append(line)
                    tail = tail[-80:]
                job["log_tail"] = "\n".join(tail)
                if time.time() - last_save > 2:
                    self.save(job)
                    last_save = time.time()

        code = proc.wait()
        with self.lock:
            self.current = None
            if job["status"] != "canceled":
                if code == 0 and self.weights_file(job):
                    job["status"] = "succeeded"
                    job["step"] = job["steps"]
                else:
                    job["status"] = "failed"
                    job["error"] = self.guess_error("\n".join(tail)) or f"ai-toolkit exited with code {code}"
            job["finished_at"] = time.time()
            self.save(job)

    @staticmethod
    def guess_error(log):
        hints = [
            ("CUDA out of memory", "GPU ran out of memory. Try SDXL, a lower rank, or close other GPU apps."),
            ("gated repo", "This model is gated on Hugging Face. Accept its license on huggingface.co and run `huggingface-cli login`, then download it again."),
            ("401 Client Error", "Hugging Face rejected the request. Run `huggingface-cli login` with a token that has access."),
            ("LocalEntryNotFoundError", "Base model isn't downloaded yet and there's no internet. Download it first while online."),
            ("No module named", "ai-toolkit's Python packages aren't installed. Re-run the setup script."),
            ("Torch not compiled with CUDA", "PyTorch was installed without CUDA. Re-run the setup script."),
        ]
        for needle, hint in hints:
            if needle in log:
                return hint
        return None

    def output_dir(self, job):
        return self.job_dir(job["id"]) / "output" / job["slug"]

    def weights_file(self, job):
        final = self.output_dir(job) / f"{job['slug']}.safetensors"
        if final.exists():
            return final
        steps = sorted(self.output_dir(job).glob(f"{job['slug']}_*.safetensors"))
        return steps[-1] if steps else None

    def public(self, job):
        out = {k: v for k, v in job.items() if k != "slug"}
        weights = self.weights_file(job)
        out["weights"] = f"jobs/{job['id']}/files/{weights.name}" if weights else None
        samples_dir = self.output_dir(job) / "samples"
        samples = sorted(
            (p for p in samples_dir.glob("*") if p.suffix.lower() in IMAGE_EXTS | VIDEO_EXTS),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        ) if samples_dir.exists() else []
        out["samples"] = [f"jobs/{job['id']}/files/samples/{p.name}" for p in samples[:24]]
        if job["status"] == "queued":
            out["queue_position"] = self.queue.index(job["id"]) + 1 if job["id"] in self.queue else None
        return out

    # -- base model downloads (Hugging Face cache)

    def hf(self, code, timeout=None):
        return subprocess.run(
            [self.python, "-c", code],
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(self.toolkit),
        )

    def repos(self, model_id):
        preset = MODELS[model_id]
        return [preset["repo"], *preset.get("extra_repos", [])]

    def refresh_cache(self):
        for model_id in MODELS:
            code = (
                "from huggingface_hub import snapshot_download\n"
                f"for r in {self.repos(model_id)!r}:\n"
                "    snapshot_download(r, local_files_only=True)\n"
            )
            try:
                self.cached[model_id] = self.hf(code, timeout=120).returncode == 0
            except Exception:
                self.cached[model_id] = False

    def download(self, model_id):
        if self.downloads.get(model_id, {}).get("status") == "downloading":
            return
        self.downloads[model_id] = {"status": "downloading", "log": ""}

        def go():
            code = (
                "from huggingface_hub import snapshot_download\n"
                f"for r in {self.repos(model_id)!r}:\n"
                "    print('downloading', r, flush=True)\n"
                "    snapshot_download(r)\n"
            )
            res = self.hf(code)
            ok = res.returncode == 0
            self.cached[model_id] = ok
            log = (res.stdout + res.stderr)[-2000:]
            self.downloads[model_id] = {
                "status": "done" if ok else "failed",
                "log": log,
                "error": None if ok else (self.guess_error(log) or "Download failed"),
            }

        threading.Thread(target=go, daemon=True).start()

    def models(self):
        return [
            {
                "id": mid,
                "name": p["name"],
                "repo": p["repo"],
                "media": p["media"],
                "vram_gb": p["vram"],
                "gated": p["gated"],
                "note": p["note"],
                "default_rank": p["rank"],
                "downloaded": self.cached.get(mid),
                "download": self.downloads.get(mid),
            }
            for mid, p in MODELS.items()
        ]


# ---------------------------------------------------------------- HTTP


def make_handler(store: Store, allowed_origins):
    def origin_allowed(origin):
        if not origin:
            return True  # same-origin or non-browser client
        if origin in allowed_origins or "*" in allowed_origins:
            return True
        host = urlparse(origin).hostname or ""
        return host in ("localhost", "127.0.0.1", "tauri.localhost", "::1")

    class Handler(BaseHTTPRequestHandler):
        server_version = f"LoRAStudioLocal/{VERSION}"

        def log_message(self, fmt, *args):
            pass

        def cors(self):
            origin = self.headers.get("Origin")
            if origin and origin_allowed(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Access-Control-Allow-Private-Network", "true")

        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def guard(self):
            if not origin_allowed(self.headers.get("Origin")):
                self.reply(403, {"error": "origin not allowed; start the trainer with --allow-origin"})
                return False
            return True

        def body(self):
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_UPLOAD_BYTES:
                raise ValueError("upload too large")
            return self.rfile.read(length)

        def do_OPTIONS(self):
            self.send_response(204)
            self.cors()
            self.end_headers()

        def route(self, method):
            if not self.guard():
                return
            parts = [unquote(p) for p in urlparse(self.path).path.strip("/").split("/") if p]
            try:
                self.dispatch(method, parts)
            except KeyError:
                self.reply(404, {"error": "not found"})
            except ValueError as e:
                self.reply(400, {"error": str(e)})
            except Exception as e:  # noqa: BLE001
                self.reply(500, {"error": str(e)})

        def dispatch(self, method, parts):
            if method == "GET" and parts == ["health"]:
                return self.reply(200, {
                    "ok": True,
                    "version": VERSION,
                    "toolkit": str(store.toolkit),
                    "toolkit_found": (store.toolkit / "run.py").exists(),
                    "gpus": store.gpus,
                })
            if method == "GET" and parts == ["models"]:
                return self.reply(200, {"models": store.models()})
            if method == "POST" and len(parts) == 3 and parts[0] == "models" and parts[2] == "download":
                if parts[1] not in MODELS:
                    raise KeyError(parts[1])
                store.download(parts[1])
                return self.reply(202, {"ok": True})
            if method == "GET" and parts == ["jobs"]:
                jobs = sorted(store.jobs.values(), key=lambda j: j["created_at"], reverse=True)
                return self.reply(200, {"jobs": [store.public(j) for j in jobs]})
            if method == "POST" and parts == ["jobs"]:
                settings = json.loads(self.body() or b"{}")
                return self.reply(201, store.public(store.create_job(settings)))
            if len(parts) >= 2 and parts[0] == "jobs":
                job = store.jobs[parts[1]]
                if method == "GET" and len(parts) == 2:
                    return self.reply(200, store.public(job))
                if method == "DELETE" and len(parts) == 2:
                    store.delete(job["id"])
                    return self.reply(200, {"ok": True})
                if method == "PUT" and parts[2:] == ["dataset"]:
                    if job["status"] != "uploading":
                        raise ValueError("dataset already uploaded")
                    try:
                        store.receive_dataset(job["id"], self.body())
                    except Exception as e:
                        job.update(status="failed", error=str(e))
                        store.save(job)
                        raise ValueError(str(e))
                    return self.reply(200, store.public(job))
                if method == "POST" and parts[2:] == ["cancel"]:
                    store.cancel(job["id"])
                    return self.reply(200, store.public(job))
                if method == "GET" and len(parts) >= 4 and parts[2] == "files":
                    return self.send_file(store.output_dir(job), parts[3:])
            raise KeyError("/".join(parts))

        def send_file(self, root: Path, rel_parts):
            root = root.resolve()
            path = root.joinpath(*rel_parts).resolve()
            if root not in path.parents or not path.is_file():
                raise KeyError(str(path))
            types = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm"}
            ctype = types.get(path.suffix.lower(), "application/octet-stream")
            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(path.stat().st_size))
            if ctype == "application/octet-stream":
                self.send_header("Content-Disposition", f'attachment; filename="{path.name}"')
            self.end_headers()
            with open(path, "rb") as f:
                shutil.copyfileobj(f, self.wfile)

        def do_GET(self):
            self.route("GET")

        def do_POST(self):
            self.route("POST")

        def do_PUT(self):
            self.route("PUT")

        def do_DELETE(self):
            self.route("DELETE")

    return Handler


def main():
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="LoRA Studio local trainer")
    parser.add_argument("--toolkit", default=str(here / "ai-toolkit"), help="path to the ai-toolkit checkout")
    parser.add_argument("--home", default=str(Path.home() / ".lora-studio"), help="where jobs and outputs are stored")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8676)
    parser.add_argument("--allow-origin", action="append", default=[], help="extra web origin allowed to use the trainer, e.g. https://my-app.vercel.app")
    args = parser.parse_args()

    toolkit = Path(args.toolkit).resolve()
    if not (toolkit / "run.py").exists():
        print(f"warning: ai-toolkit not found at {toolkit} (run the setup script first)")

    store = Store(toolkit, Path(args.home).expanduser())
    server = ThreadingHTTPServer((args.host, args.port), make_handler(store, set(args.allow_origin)))
    gpus = ", ".join(f"{g['name']} ({g['vram_gb']}GB)" for g in store.gpus) or "no NVIDIA GPU detected"
    print(f"LoRA Studio local trainer {VERSION}")
    print(f"  ai-toolkit: {toolkit}")
    print(f"  jobs:       {store.jobs_dir}")
    print(f"  GPU:        {gpus}")
    print(f"  listening:  http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
