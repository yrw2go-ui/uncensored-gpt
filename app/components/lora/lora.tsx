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
  BASE_MODELS,
  LORA_PRESETS,
  LORA_TYPES,
  LocalHealth,
  LocalModel,
  LoraJob,
  SchemaField,
  TrainerSchema,
  findRoleField,
  isLoraDone,
  loraFileName,
  roleKeys,
  useLoraStore,
} from "@/app/store/lora";
import { ZipEntry, createZip } from "@/app/utils/zip";
import {
  buildComfyWorkflow,
  comfyReadme,
  comfyTemplateFor,
} from "@/app/utils/comfy";
import { nanoid } from "nanoid";

const MIN_IMAGES = 5;
const MAX_IMAGES = 40;
const MAX_SIDE = 1024;
// Vercel and most edge hosts cap request bodies around 4.5MB
const MAX_DATASET_BYTES = 4.4 * 1024 * 1024;

type DatasetItem = {
  id: string;
  name: string;
  ext: string;
  kind: "image" | "video";
  preview: string;
  data: Uint8Array;
  caption: string;
};

async function prepareImage(file: File): Promise<DatasetItem> {
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
    ext: "jpg",
    kind: "image",
    preview: URL.createObjectURL(blob),
    data: new Uint8Array(await blob.arrayBuffer()),
    caption: "",
  };
}

async function prepareVideo(file: File): Promise<DatasetItem> {
  return {
    id: nanoid(),
    name: file.name,
    ext: file.name.split(".").pop()?.toLowerCase() || "mp4",
    kind: "video",
    preview: URL.createObjectURL(file),
    data: new Uint8Array(await file.arrayBuffer()),
    caption: "",
  };
}

function isVideoUrl(url: string) {
  return /\.(mp4|webm|mov)(\?|$)/i.test(url);
}

function statusColor(status: string) {
  if (status === "succeeded") return "green";
  if (status === "failed" || status === "canceled") return "red";
  return "var(--primary)";
}

function FieldEditor(props: {
  field: SchemaField;
  value: any;
  onChange: (v: any) => void;
}) {
  const { field, value, onChange } = props;
  const current = value ?? field.default;
  if (field.enum) {
    return (
      <Select
        value={String(current ?? "")}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          onChange(field.enum!.find((v) => String(v) === raw));
        }}
      >
        {field.enum.map((v) => (
          <option key={String(v)} value={String(v)}>
            {String(v)}
          </option>
        ))}
      </Select>
    );
  }
  if (field.type === "boolean") {
    return (
      <input
        type="checkbox"
        checked={!!current}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
    );
  }
  if (field.type === "integer" || field.type === "number") {
    return (
      <input
        type="number"
        value={current ?? ""}
        min={field.minimum}
        max={field.maximum}
        step={field.type === "integer" ? 1 : "any"}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          onChange(raw === "" ? undefined : Number(raw));
        }}
      />
    );
  }
  return (
    <input
      type="text"
      value={current ?? ""}
      onChange={(e) => onChange(e.currentTarget.value || undefined)}
    />
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// zip with a ComfyUI workflow, its API-format twin, setup notes and, for
// local trainings, the LoRA itself
// zip with a ComfyUI workflow, its API-format twin, setup notes and the
// LoRA itself, ready to drop into a ComfyUI folder
async function exportComfy(job: LoraJob, safetensors: Blob) {
  const template = comfyTemplateFor(job.modelId);
  if (!template) throw new Error("No ComfyUI template for this base model");

  const loraFile = loraFileName(job);
  const slug = loraFile.replace(/\.safetensors$/, "");
  const loraType = LORA_TYPES.find((t) => t.name === job.loraType);
  const prompt = (loraType ?? LORA_TYPES[0]).caption(job.triggerWord);
  const { workflow, api } = buildComfyWorkflow(template, loraFile, prompt);

  const encoder = new TextEncoder();
  const workflowFile = `${slug}_workflow.json`;
  const entries: ZipEntry[] = [
    {
      name: workflowFile,
      data: encoder.encode(JSON.stringify(workflow, null, 2)),
    },
    {
      name: `${slug}_workflow_api.json`,
      data: encoder.encode(JSON.stringify(api, null, 2)),
    },
    {
      name: `ComfyUI/models/loras/${loraFile}`,
      data: new Uint8Array(await safetensors.arrayBuffer()),
    },
    {
      name: "README.txt",
      data: encoder.encode(
        comfyReadme({
          template,
          loraName: job.name,
          loraFile,
          cloudSdxl: job.modelId === "sdxl" && job.backend !== "local",
          triggerWord: job.triggerWord,
          prompt,
          workflowFile,
        }),
      ),
    },
  ];

  downloadBlob(createZip(entries), `${slug}_comfyui.zip`);
}

function JobCard(props: { job: LoraJob }) {
  const { job } = props;
  const store = useLoraStore();
  const [prompt, setPrompt] = useState(`a photo of ${job.triggerWord}`);
  const [showLogs, setShowLogs] = useState(false);
  const [busy, setBusy] = useState<"" | "download" | "comfy">("");
  const comfyTemplate = comfyTemplateFor(job.modelId);
  const running = !isLoraDone(job.status);
  const isLocal = job.backend === "local";

  // both buttons need the unpacked, stamped .safetensors
  function withSafetensors(
    kind: "download" | "comfy",
    then: (file: Blob) => void | Promise<void>,
  ) {
    setBusy(kind);
    store
      .getSafetensors(job.id)
      .then(then)
      .catch((e) => showToast(e.message))
      .finally(() => setBusy(""));
  }
  const statusText =
    job.status === "queued" && job.queuePosition
      ? `queued (#${job.queuePosition})`
      : job.status === "processing" && isLocal && job.step
        ? `${job.step}/${job.steps} steps`
        : job.status;

  return (
    <div className={styles["job"]}>
      <div className={styles["job-header"]}>
        <div>
          <div className={styles["job-title"]}>{job.name}</div>
          <div className={styles["job-meta"]}>
            {isLocal ? "This PC · " : ""}
            {job.baseModel}
            {job.loraType && ` · ${job.loraType}`} · trigger:{" "}
            <code>{job.triggerWord}</code> · {job.imageCount} files ·{" "}
            {new Date(job.createdAt).toLocaleString()}
          </div>
        </div>
        <div className={styles["job-actions"]}>
          <span style={{ color: statusColor(job.status) }}>
            {running && <LoadingIcon />} {statusText}
          </span>
          {running && (job.trainingId || job.localId) && (
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

      {isLocal && job.status === "processing" && (
        <div className={styles["progress"]}>
          <div
            style={{
              width: `${Math.round(((job.step ?? 0) / job.steps) * 100)}%`,
            }}
          />
        </div>
      )}

      {job.error && <div className={styles["error"]}>{job.error}</div>}

      {isLocal && !!job.localSamples?.length && (
        <>
          <div className={styles["job-meta"]}>
            Samples generated during training
          </div>
          <div className={styles["samples"]}>
            {job.localSamples.map((path) => {
              const url = store.localFileUrl(path);
              return (
                <div key={path} className={styles["sample"]}>
                  {isVideoUrl(url) ? (
                    <video src={url} controls loop muted />
                  ) : (
                    <a href={url} target="_blank" rel="noreferrer">
                      <img src={url} alt="training sample" />
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

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
              <IconButton
                icon={<DownloadIcon />}
                text={
                  busy === "download" ? "Preparing…" : "Download .safetensors"
                }
                bordered
                disabled={!!busy}
                onClick={() =>
                  withSafetensors("download", (file) =>
                    downloadBlob(file, loraFileName(job)),
                  )
                }
              />
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
            {comfyTemplate && job.weights && (
              <IconButton
                text={busy === "comfy" ? "Preparing…" : "Export for ComfyUI"}
                bordered
                disabled={!!busy}
                onClick={() =>
                  withSafetensors("comfy", (file) => exportComfy(job, file))
                }
              />
            )}
          </div>
          {job.version && (
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
          )}
          <div className={styles["samples"]}>
            {job.samples.map((s) => (
              <div key={s.id} className={styles["sample"]} title={s.prompt}>
                {s.images[0] ? (
                  isVideoUrl(s.images[0]) ? (
                    <video src={s.images[0]} controls loop muted />
                  ) : (
                    <a href={s.images[0]} target="_blank" rel="noreferrer">
                      <img src={s.images[0]} alt={s.prompt} />
                    </a>
                  )
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

function LocalSetup(props: {
  health: LocalHealth | null;
  error: string;
  models: LocalModel[];
  modelId: string;
  onModel: (id: string) => void;
  onRetry: () => void;
}) {
  const store = useLoraStore();
  const { health, error, models, modelId } = props;
  const model = models.find((m) => m.id === modelId);
  const gpu = health?.gpus[0];

  return (
    <List>
      <ListItem
        title="Local trainer"
        subTitle={
          health
            ? `Connected · ${gpu ? `${gpu.name} (${gpu.vram_gb}GB)` : "no NVIDIA GPU detected"}${
                health.toolkit_found ? "" : " · ai-toolkit not installed"
              }`
            : error ||
              "Run local-trainer/setup then local-trainer/start on this PC"
        }
      >
        <div className={styles["inline"]}>
          <input
            type="text"
            value={store.localUrl}
            onChange={(e) => store.setLocalUrl(e.currentTarget.value)}
          />
          <IconButton text="Retry" bordered onClick={props.onRetry} />
        </div>
      </ListItem>
      {health && models.length > 0 ? (
        <ListItem
          title="Base model"
          subTitle={
            model
              ? `${model.note} Needs ~${model.vram_gb}GB VRAM.${
                  gpu && gpu.vram_gb < model.vram_gb
                    ? ` Your GPU has ${gpu.vram_gb}GB, so this may run out of memory.`
                    : ""
                }`
              : ""
          }
        >
          <Select
            value={modelId}
            onChange={(e) => props.onModel(e.currentTarget.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.downloaded ? " ✓" : ""}
              </option>
            ))}
          </Select>
        </ListItem>
      ) : (
        <></>
      )}
      {health && model ? (
        <ListItem
          title="Offline use"
          subTitle={
            model.download?.status === "failed"
              ? model.download.error || "Download failed"
              : model.downloaded
                ? "Downloaded. Training works without internet."
                : model.download?.status === "downloading"
                  ? `Downloading ${model.repo}… this can take a while`
                  : `Download ${model.repo} once while online${
                      model.gated
                        ? " (gated: accept the license on Hugging Face and run huggingface-cli login first)"
                        : ""
                    }`
          }
        >
          {model.downloaded ? (
            <span style={{ color: "green" }}>Ready offline</span>
          ) : model.download?.status === "downloading" ? (
            <LoadingIcon />
          ) : (
            <IconButton
              icon={<DownloadIcon />}
              text="Download"
              bordered
              onClick={() =>
                store
                  .downloadLocalModel(model.id)
                  .then(props.onRetry)
                  .catch((e) => showToast(e.message))
              }
            />
          )}
        </ListItem>
      ) : (
        <></>
      )}
    </List>
  );
}

export function LoraStudio() {
  const navigate = useNavigate();
  const store = useLoraStore();
  const fileInput = useRef<HTMLInputElement>(null);

  const [baseModelId, setBaseModelId] = useState(BASE_MODELS[0].id);
  const [customTrainer, setCustomTrainer] = useState("");
  const [loraTypeId, setLoraTypeId] = useState(LORA_TYPES[0].id);
  const [schema, setSchema] = useState<TrainerSchema | null>(null);
  const [schemaError, setSchemaError] = useState("");
  const [overrides, setOverrides] = useState<Record<string, any>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [name, setName] = useState("");
  const [triggerWord, setTriggerWord] = useState("TOK");
  const [steps, setSteps] = useState(LORA_PRESETS[1].steps);
  const [autocaption, setAutocaption] = useState(true);
  const [consent, setConsent] = useState(false);
  const [items, setItems] = useState<DatasetItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const isLocal = store.backend === "local";
  const [health, setHealth] = useState<LocalHealth | null>(null);
  const [healthError, setHealthError] = useState("");
  const [localModels, setLocalModels] = useState<LocalModel[]>([]);
  const [localModelId, setLocalModelId] = useState("");
  const [rank, setRank] = useState(16);
  const [lr, setLr] = useState(0.0001);
  const [samplePrompts, setSamplePrompts] = useState("");

  const baseModel = BASE_MODELS.find((m) => m.id === baseModelId)!;
  const loraType = LORA_TYPES.find((t) => t.id === loraTypeId)!;
  const trainer = baseModel.trainer || customTrainer.trim();
  const localModel = localModels.find((m) => m.id === localModelId);
  const acceptsVideo = isLocal
    ? localModel?.media === "video"
    : baseModel.media === "video";

  // talk to the local trainer while "This PC" is selected
  function refreshLocal() {
    Promise.all([store.localHealth(), store.localModels()])
      .then(([h, models]) => {
        setHealth(h);
        setHealthError("");
        setLocalModels(models);
        setLocalModelId((id) => id || models[0]?.id || "");
      })
      .catch((e) => {
        setHealth(null);
        setHealthError(e.message);
      });
  }
  useEffect(() => {
    if (!isLocal) return;
    refreshLocal();
    const timer = setInterval(refreshLocal, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocal, store.localUrl]);

  useEffect(() => {
    if (localModel) setRank(localModel.default_rank);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localModelId]);

  // load the selected trainer's input schema
  useEffect(() => {
    setSchema(null);
    setSchemaError("");
    setOverrides({});
    if (!/^[\w.-]+\/[\w.-]+$/.test(trainer)) return;
    let cancelled = false;
    const timer = setTimeout(
      () => {
        store
          .fetchTrainerSchema(trainer)
          .then((s) => !cancelled && setSchema(s))
          .catch((e) => !cancelled && setSchemaError(e.message));
      },
      baseModel.trainer ? 0 : 600,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trainer]);

  // poll unfinished trainings
  const pending = store.jobs
    .filter((j) => (j.trainingId || j.localId) && !isLoraDone(j.status))
    .map((j) => j.id)
    .join(",");
  useEffect(() => {
    if (!pending) return;
    const ids = pending.split(",");
    const tick = () => ids.forEach((id) => store.refreshJob(id));
    tick();
    const timer = setInterval(tick, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files).filter(
      (f) =>
        f.type.startsWith("image/") ||
        (acceptsVideo && f.type.startsWith("video/")),
    );
    const room = MAX_IMAGES - items.length;
    if (list.length > room) showToast(`Only ${MAX_IMAGES} files allowed`);
    const prepared: DatasetItem[] = [];
    for (const f of list.slice(0, room)) {
      try {
        prepared.push(
          f.type.startsWith("video/")
            ? await prepareVideo(f)
            : await prepareImage(f),
        );
      } catch {
        showToast(`Couldn't read ${f.name}`);
      }
    }
    setItems((prev) => [...prev, ...prepared]);
  }

  function removeItem(id: string) {
    setItems((prev) => {
      const item = prev.find((i) => i.id === id);
      if (item) URL.revokeObjectURL(item.preview);
      return prev.filter((i) => i.id !== id);
    });
  }

  const encoder = new TextEncoder();
  function buildDataset() {
    return createZip(
      items.flatMap((item, i) => {
        const base = `${item.kind}_${String(i + 1).padStart(3, "0")}`;
        const entries = [{ name: `${base}.${item.ext}`, data: item.data }];
        if (item.caption.trim()) {
          entries.push({
            name: `${base}.txt`,
            data: encoder.encode(item.caption.trim()),
          });
        }
        return entries;
      }),
    );
  }

  const handled = schema ? roleKeys(schema) : new Set<string>();
  const advancedFields =
    schema?.fields.filter((f) => !handled.has(f.key)) ?? [];
  const hasRole = (role: Parameters<typeof findRoleField>[1]) =>
    !!schema && !!findRoleField(schema, role);

  const backendProblems = isLocal
    ? [
        !health && "Start the local trainer on this PC",
        health &&
          !health.toolkit_found &&
          "Install ai-toolkit (local-trainer/setup)",
        health && !localModel && "Pick a base model",
      ]
    : [
        !trainer && "Enter a trainer as owner/model",
        schemaError && `Trainer: ${schemaError}`,
        trainer && !schema && !schemaError && "Loading trainer settings…",
        schema && !hasRole("dataset") && "This trainer has no dataset input",
      ];
  const defaultPrompts = [
    loraType.caption(triggerWord.trim() || "TOK"),
    `${loraType.caption(triggerWord.trim() || "TOK")}, cinematic lighting`,
  ];

  const problems = [
    ...backendProblems,
    !name.trim() && "Give your LoRA a name",
    !/^[A-Za-z0-9_ ]{2,}$/.test(triggerWord) &&
      "Trigger word: letters, digits, spaces or _ only",
    items.length < MIN_IMAGES && `Add at least ${MIN_IMAGES} files`,
    !consent && "Confirm the image rights checkbox",
  ].filter(Boolean) as string[];

  async function train() {
    const dataset = buildDataset();
    if (isLocal) {
      if (!localModel) return;
      setBusy(true);
      try {
        await store.startLocalTraining({
          name: name.trim(),
          model: localModel,
          loraType,
          triggerWord: triggerWord.trim(),
          steps,
          rank,
          lr,
          samplePrompts: (samplePrompts.trim()
            ? samplePrompts.split("\n")
            : defaultPrompts
          )
            .map((p) => p.trim())
            .filter(Boolean),
          dataset,
          imageCount: items.length,
        });
        resetForm();
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!schema) return;
    if (dataset.size > MAX_DATASET_BYTES) {
      showToast("Dataset is too large to upload; remove a few files");
      return;
    }
    setBusy(true);
    try {
      await store.startTraining({
        name: name.trim(),
        baseModel,
        loraType,
        schema,
        triggerWord: triggerWord.trim(),
        steps,
        autocaption,
        overrides: Object.fromEntries(
          Object.entries(overrides).filter(([, v]) => v !== undefined),
        ),
        dataset,
        imageCount: items.length,
      });
      resetForm();
    } finally {
      setBusy(false);
    }
  }

  function resetForm() {
    items.forEach((i) => URL.revokeObjectURL(i.preview));
    setItems([]);
    setName("");
    setConsent(false);
  }

  return (
    <ErrorBoundary>
      <div className={styles["lora-page"]}>
        <div className="window-header">
          <div className="window-header-title">
            <div className="window-header-main-title">LoRA Studio</div>
            <div className="window-header-sub-title">
              Train image and video LoRAs from your files in a few clicks
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
              title="Train on"
              subTitle={
                isLocal
                  ? "Your own NVIDIA GPU via ai-toolkit. Free, private, and works offline once the base model is downloaded."
                  : "Replicate's cloud GPUs. No setup, pay per training."
              }
            >
              <Select
                value={store.backend}
                onChange={(e) =>
                  store.setBackend(
                    e.currentTarget.value as "replicate" | "local",
                  )
                }
              >
                <option value="replicate">Cloud (Replicate)</option>
                <option value="local">This PC (ai-toolkit)</option>
              </Select>
            </ListItem>
          </List>

          {isLocal ? (
            <LocalSetup
              health={health}
              error={healthError}
              models={localModels}
              modelId={localModelId}
              onModel={setLocalModelId}
              onRetry={refreshLocal}
            />
          ) : (
            <List>
              <ListItem
                title="Replicate API token"
                subTitle="Optional if the server has REPLICATE_API_TOKEN set. Training is billed to that Replicate account (usually a few dollars)."
              >
                <PasswordInput
                  value={store.replicateToken}
                  type="text"
                  placeholder="r8_..."
                  onChange={(e) => store.setToken(e.currentTarget.value)}
                />
              </ListItem>
            </List>
          )}

          <h3>1. Choose what to train</h3>
          <List>
            {!isLocal ? (
              <ListItem title="Base model" subTitle={baseModel.note}>
                <Select
                  value={baseModelId}
                  onChange={(e) => setBaseModelId(e.currentTarget.value)}
                >
                  {BASE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </ListItem>
            ) : (
              <></>
            )}
            {!isLocal && !baseModel.trainer ? (
              <ListItem
                title="Trainer"
                subTitle="Replicate owner/model of a trainable LoRA trainer"
              >
                <input
                  type="text"
                  value={customTrainer}
                  placeholder="owner/model"
                  onChange={(e) => setCustomTrainer(e.currentTarget.value)}
                />
              </ListItem>
            ) : (
              <></>
            )}
            <ListItem title="LoRA type" subTitle={loraType.tips}>
              <Select
                value={loraTypeId}
                onChange={(e) => setLoraTypeId(e.currentTarget.value)}
              >
                {LORA_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </ListItem>
          </List>
          {!isLocal && schemaError && (
            <div className={styles["error"]}>{schemaError}</div>
          )}

          <h3>2. Describe it</h3>
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
                onChange={(e) => setTriggerWord(e.currentTarget.value)}
              />
            </ListItem>
            {isLocal || hasRole("steps") ? (
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
            ) : (
              <></>
            )}
            {!isLocal && hasRole("autocaption") ? (
              <ListItem
                title="Auto-caption"
                subTitle="Let the trainer describe each file. Captions you type below take priority."
              >
                <input
                  type="checkbox"
                  checked={autocaption}
                  onChange={(e) => setAutocaption(e.currentTarget.checked)}
                />
              </ListItem>
            ) : (
              <></>
            )}
          </List>

          {isLocal && localModel && (
            <div className={styles["advanced"]}>
              <span
                className="clickable"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                {showAdvanced ? "Hide" : "Show"} advanced settings
              </span>
              {showAdvanced && (
                <List>
                  <ListItem
                    title="LoRA rank"
                    subTitle="Higher captures more detail but makes bigger files and needs more VRAM"
                  >
                    <input
                      type="number"
                      min={4}
                      max={128}
                      value={rank}
                      onChange={(e) => setRank(Number(e.currentTarget.value))}
                    />
                  </ListItem>
                  <ListItem title="Learning rate">
                    <input
                      type="number"
                      step="any"
                      value={lr}
                      onChange={(e) => setLr(Number(e.currentTarget.value))}
                    />
                  </ListItem>
                  <ListItem
                    title="Sample prompts"
                    subTitle="One per line. Rendered during training so you can watch it learn. Leave empty for defaults."
                    vertical
                  >
                    <textarea
                      className={styles["prompts"]}
                      rows={3}
                      value={samplePrompts}
                      placeholder={defaultPrompts.join("\n")}
                      onChange={(e) => setSamplePrompts(e.currentTarget.value)}
                    />
                  </ListItem>
                </List>
              )}
            </div>
          )}

          {!isLocal && advancedFields.length > 0 && (
            <div className={styles["advanced"]}>
              <span
                className="clickable"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                {showAdvanced ? "Hide" : "Show"} advanced settings (
                {advancedFields.length})
              </span>
              {showAdvanced && (
                <List>
                  {advancedFields.map((f) => (
                    <ListItem
                      key={f.key}
                      title={f.key}
                      subTitle={f.description}
                    >
                      <FieldEditor
                        field={f}
                        value={overrides[f.key]}
                        onChange={(v) =>
                          setOverrides((prev) => ({ ...prev, [f.key]: v }))
                        }
                      />
                    </ListItem>
                  ))}
                </List>
              )}
            </div>
          )}

          <h3>
            3. Add {acceptsVideo ? "clips or images" : "images"} ({items.length}
            /{MAX_IMAGES})
          </h3>
          <div className={styles["tips"]}>
            {loraType.tips} Images are resized to {MAX_SIDE}px in your browser
            before upload
            {acceptsVideo && "; keep video clips short (a few seconds each)"}.
            {isLocal &&
              ` Files without a caption are captioned "${loraType.caption(
                triggerWord.trim() || "TOK",
              )}".`}
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
            <div>Drop files here or click to browse</div>
            <input
              ref={fileInput}
              type="file"
              accept={acceptsVideo ? "image/*,video/*" : "image/*"}
              multiple
              hidden
              onChange={(e) => {
                if (e.currentTarget.files) addFiles(e.currentTarget.files);
                e.currentTarget.value = "";
              }}
            />
          </div>

          {items.length > 0 && (
            <div className={styles["grid"]}>
              {items.map((item) => (
                <div key={item.id} className={styles["thumb"]}>
                  {item.kind === "video" ? (
                    <video src={item.preview} muted loop autoPlay />
                  ) : (
                    <img src={item.preview} alt={item.name} />
                  )}
                  <div
                    className={styles["thumb-remove"]}
                    onClick={() => removeItem(item.id)}
                  >
                    <CloseIcon />
                  </div>
                  <input
                    type="text"
                    value={item.caption}
                    placeholder="caption (optional)"
                    onChange={(e) => {
                      const caption = e.currentTarget.value;
                      setItems((prev) =>
                        prev.map((i) =>
                          i.id === item.id ? { ...i, caption } : i,
                        ),
                      );
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          <h3>4. Train</h3>
          <label className={styles["consent"]}>
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.currentTarget.checked)}
            />
            <span>
              I own these files or have the rights to use them, and any real
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
