import styles from "./lora.module.scss";
import { IconButton } from "@/app/components/button";
import {
  List,
  ListItem,
  PasswordInput,
  Select,
  showToast,
} from "@/app/components/ui-lib";
import { ErrorBoundary } from "@/app/components/error";
import CloseIcon from "@/app/icons/close.svg";
import DeleteIcon from "@/app/icons/delete.svg";
import DownloadIcon from "@/app/icons/download.svg";
import UploadIcon from "@/app/icons/upload.svg";
import LoadingIcon from "@/app/icons/three-dots.svg";
import { Path } from "@/app/constant";
import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import {
  LORA_PRESETS,
  LoraJob,
  isLoraDone,
  useLoraStore,
} from "@/app/store/lora";
import { createZip } from "@/app/utils/zip";
import { nanoid } from "nanoid";

const MIN_IMAGES = 5;
const MAX_IMAGES = 40;
const MAX_SIDE = 1024;
// Vercel and most edge hosts cap request bodies around 4.5MB
const MAX_DATASET_BYTES = 4.4 * 1024 * 1024;

type DatasetImage = {
  id: string;
  name: string;
  preview: string;
  data: Uint8Array;
  caption: string;
};

async function prepareImage(file: File): Promise<DatasetImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("encode failed"))),
      "image/jpeg",
      0.9,
    ),
  );
  return {
    id: nanoid(),
    name: file.name,
    preview: URL.createObjectURL(blob),
    data: new Uint8Array(await blob.arrayBuffer()),
    caption: "",
  };
}

function statusColor(status: string) {
  if (status === "succeeded") return "green";
  if (status === "failed" || status === "canceled") return "red";
  return "var(--primary)";
}

function JobCard(props: { job: LoraJob }) {
  const { job } = props;
  const store = useLoraStore();
  const [prompt, setPrompt] = useState(`a photo of ${job.triggerWord}`);
  const [showLogs, setShowLogs] = useState(false);
  const running = !isLoraDone(job.status);

  return (
    <div className={styles["job"]}>
      <div className={styles["job-header"]}>
        <div>
          <div className={styles["job-title"]}>{job.name}</div>
          <div className={styles["job-meta"]}>
            trigger: <code>{job.triggerWord}</code> · {job.imageCount} images ·{" "}
            {job.steps} steps · {new Date(job.createdAt).toLocaleString()}
          </div>
        </div>
        <div className={styles["job-actions"]}>
          <span style={{ color: statusColor(job.status) }}>
            {running && <LoadingIcon />} {job.status}
          </span>
          {running && job.trainingId && (
            <IconButton
              text="Cancel"
              bordered
              onClick={() =>
                store.cancelJob(job.id).catch((e) => showToast(e.message))
              }
            />
          )}
          {!running && (
            <IconButton
              icon={<DeleteIcon />}
              bordered
              onClick={() => store.removeJob(job.id)}
            />
          )}
        </div>
      </div>

      {job.error && <div className={styles["error"]}>{job.error}</div>}

      {job.logs && (
        <div>
          <span className="clickable" onClick={() => setShowLogs(!showLogs)}>
            {showLogs ? "Hide" : "Show"} training log
          </span>
          {showLogs && <pre className={styles["logs"]}>{job.logs}</pre>}
        </div>
      )}

      {job.status === "succeeded" && (
        <>
          <div className={styles["job-links"]}>
            {job.weights && (
              <a href={job.weights} target="_blank" rel="noreferrer">
                <IconButton
                  icon={<DownloadIcon />}
                  text="Download .safetensors"
                  bordered
                />
              </a>
            )}
            {job.destination && (
              <a
                href={`https://replicate.com/${job.destination}`}
                target="_blank"
                rel="noreferrer"
              >
                <IconButton text="Open on Replicate" bordered />
              </a>
            )}
          </div>
          <div className={styles["try-row"]}>
            <input
              type="text"
              value={prompt}
              placeholder={`Prompt using ${job.triggerWord}`}
              onChange={(e) => setPrompt(e.currentTarget.value)}
            />
            <IconButton
              text="Generate"
              type="primary"
              disabled={!prompt.trim()}
              onClick={() => store.generateSample(job.id, prompt.trim())}
            />
          </div>
          <div className={styles["samples"]}>
            {job.samples.map((s) => (
              <div key={s.id} className={styles["sample"]} title={s.prompt}>
                {s.images[0] ? (
                  <a href={s.images[0]} target="_blank" rel="noreferrer">
                    <img src={s.images[0]} alt={s.prompt} />
                  </a>
                ) : (
                  <div className={styles["sample-placeholder"]}>
                    {isLoraDone(s.status) ? (
                      s.error || s.status
                    ) : (
                      <LoadingIcon />
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function LoraStudio() {
  const navigate = useNavigate();
  const store = useLoraStore();
  const fileInput = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [triggerWord, setTriggerWord] = useState("TOK");
  const [steps, setSteps] = useState(LORA_PRESETS[1].steps);
  const [autocaption, setAutocaption] = useState(true);
  const [consent, setConsent] = useState(false);
  const [images, setImages] = useState<DatasetImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  // poll unfinished trainings
  const pending = store.jobs
    .filter((j) => j.trainingId && !isLoraDone(j.status))
    .map((j) => j.id)
    .join(",");
  useEffect(() => {
    if (!pending) return;
    const ids = pending.split(",");
    const tick = () => ids.forEach((id) => store.refreshJob(id));
    tick();
    const timer = setInterval(tick, 10_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const room = MAX_IMAGES - images.length;
    if (list.length > room) showToast(`Only ${MAX_IMAGES} images allowed`);
    const prepared: DatasetImage[] = [];
    for (const f of list.slice(0, room)) {
      try {
        prepared.push(await prepareImage(f));
      } catch {
        showToast(`Couldn't read ${f.name}`);
      }
    }
    setImages((prev) => [...prev, ...prepared]);
  }

  function removeImage(id: string) {
    setImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) URL.revokeObjectURL(img.preview);
      return prev.filter((i) => i.id !== id);
    });
  }

  const encoder = new TextEncoder();
  function buildDataset() {
    return createZip(
      images.flatMap((img, i) => {
        const base = `img_${String(i + 1).padStart(3, "0")}`;
        const entries = [{ name: `${base}.jpg`, data: img.data }];
        if (img.caption.trim()) {
          entries.push({
            name: `${base}.txt`,
            data: encoder.encode(img.caption.trim()),
          });
        }
        return entries;
      }),
    );
  }

  const problems = [
    !name.trim() && "Give your LoRA a name",
    !/^[A-Za-z0-9_]{2,}$/.test(triggerWord) &&
      "Trigger word: letters, digits or _ only",
    images.length < MIN_IMAGES && `Add at least ${MIN_IMAGES} images`,
    !consent && "Confirm the image rights checkbox",
  ].filter(Boolean) as string[];

  async function train() {
    const dataset = buildDataset();
    if (dataset.size > MAX_DATASET_BYTES) {
      showToast("Dataset is too large to upload; remove a few images");
      return;
    }
    setBusy(true);
    try {
      await store.startTraining({
        name: name.trim(),
        triggerWord,
        steps,
        autocaption,
        dataset,
        imageCount: images.length,
      });
      images.forEach((i) => URL.revokeObjectURL(i.preview));
      setImages([]);
      setName("");
      setConsent(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ErrorBoundary>
      <div className={styles["lora-page"]}>
        <div className="window-header">
          <div className="window-header-title">
            <div className="window-header-main-title">LoRA Studio</div>
            <div className="window-header-sub-title">
              Train a FLUX LoRA from your images in a few clicks
            </div>
          </div>
          <div className="window-actions">
            <div className="window-action-button">
              <IconButton
                icon={<CloseIcon />}
                bordered
                onClick={() => navigate(Path.Home)}
              />
            </div>
          </div>
        </div>

        <div className={styles["lora-body"]}>
          <List>
            <ListItem
              title="Replicate API token"
              subTitle="Optional if the server has REPLICATE_API_TOKEN set. Training costs roughly $1–4 on your Replicate account."
            >
              <PasswordInput
                value={store.replicateToken}
                type="text"
                placeholder="r8_..."
                onChange={(e) => store.setToken(e.currentTarget.value)}
              />
            </ListItem>
          </List>

          <h3>1. Describe it</h3>
          <List>
            <ListItem
              title="Name"
              subTitle="e.g. “My dog Rex” or “Watercolor style”"
            >
              <input
                type="text"
                value={name}
                placeholder="My LoRA"
                onChange={(e) => setName(e.currentTarget.value)}
              />
            </ListItem>
            <ListItem
              title="Trigger word"
              subTitle="A unique word you'll put in prompts to activate the LoRA"
            >
              <input
                type="text"
                value={triggerWord}
                onChange={(e) => setTriggerWord(e.currentTarget.value.trim())}
              />
            </ListItem>
            <ListItem title="Training length">
              <Select
                value={steps}
                onChange={(e) => setSteps(Number(e.currentTarget.value))}
              >
                {LORA_PRESETS.map((p) => (
                  <option key={p.steps} value={p.steps}>
                    {p.name} · {p.steps} steps
                  </option>
                ))}
              </Select>
            </ListItem>
            <ListItem
              title="Auto-caption"
              subTitle="Let the trainer describe each image. Captions you type below take priority."
            >
              <input
                type="checkbox"
                checked={autocaption}
                onChange={(e) => setAutocaption(e.currentTarget.checked)}
              />
            </ListItem>
          </List>

          <h3>
            2. Add images ({images.length}/{MAX_IMAGES})
          </h3>
          <div className={styles["tips"]}>
            Best results: 10–30 sharp images, varied angles, lighting and
            backgrounds; the subject clearly visible. Images are resized to{" "}
            {MAX_SIDE}px in your browser before upload.
          </div>
          <div
            className={`${styles["dropzone"]} ${dragging ? styles["dragging"] : ""}`}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addFiles(e.dataTransfer.files);
            }}
          >
            <UploadIcon />
            <div>Drop images here or click to browse</div>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.currentTarget.files) addFiles(e.currentTarget.files);
                e.currentTarget.value = "";
              }}
            />
          </div>

          {images.length > 0 && (
            <div className={styles["grid"]}>
              {images.map((img) => (
                <div key={img.id} className={styles["thumb"]}>
                  <img src={img.preview} alt={img.name} />
                  <div
                    className={styles["thumb-remove"]}
                    onClick={() => removeImage(img.id)}
                  >
                    <CloseIcon />
                  </div>
                  <input
                    type="text"
                    value={img.caption}
                    placeholder="caption (optional)"
                    onChange={(e) => {
                      const caption = e.currentTarget.value;
                      setImages((prev) =>
                        prev.map((i) =>
                          i.id === img.id ? { ...i, caption } : i,
                        ),
                      );
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          <h3>3. Train</h3>
          <label className={styles["consent"]}>
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.currentTarget.checked)}
            />
            <span>
              I own these images or have the rights to use them, and any real
              person shown has agreed to having a model trained on their
              likeness.
            </span>
          </label>
          {problems.length > 0 && (
            <ul className={styles["problems"]}>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <IconButton
            text={busy ? "Uploading…" : "Start training"}
            type="primary"
            disabled={busy || problems.length > 0}
            onClick={train}
          />

          {store.jobs.length > 0 && (
            <>
              <h3>Your LoRAs</h3>
              {store.jobs.map((job) => (
                <JobCard key={job.id} job={job} />
              ))}
            </>
          )}
        </div>
      </div>
    </ErrorBoundary>
  );
}
