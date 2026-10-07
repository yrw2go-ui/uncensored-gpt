import { ACCESS_CODE_PREFIX, ApiPath, StoreKey } from "@/app/constant";
import { getBearerToken } from "@/app/client/api";
import { createPersistStore } from "@/app/utils/store";
import { nanoid } from "nanoid";
import { useAccessStore } from "./access";
import {
  BaseModel,
  LoraType,
  TrainerSchema,
  buildTrainingInput,
  parseSchema,
} from "@/app/utils/lora-trainers";

export * from "@/app/utils/lora-trainers";

export type LoraStatus =
  | "uploading"
  | "queued"
  | "starting"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled";

export type LoraBackend = "replicate" | "local";

export const DEFAULT_LOCAL_URL = "http://127.0.0.1:8676";

// a base model as reported by the local trainer (local-trainer/server.py)
export type LocalModel = {
  id: string;
  name: string;
  repo: string;
  media: "image" | "video";
  vram_gb: number;
  gated: boolean;
  note: string;
  default_rank: number;
  downloaded: boolean | null;
  download?: { status: "downloading" | "done" | "failed"; error?: string };
};

export type LocalHealth = {
  ok: boolean;
  version: string;
  toolkit: string;
  toolkit_found: boolean;
  gpus: { name: string; vram_gb: number }[];
};

export type LoraSample = {
  id: string;
  prompt: string;
  status: LoraStatus;
  images: string[];
  error?: string;
};

export type LoraJob = {
  id: string;
  backend?: LoraBackend;
  name: string;
  // base model id (BASE_MODELS or local trainer model), used for exports
  modelId?: string;
  baseModel: string;
  loraType: string;
  trainer: string;
  triggerWord: string;
  steps: number;
  imageCount: number;
  createdAt: number;
  status: LoraStatus;
  trainingId?: string;
  destination?: string;
  version?: string;
  weights?: string;
  logs?: string;
  error?: string;
  samples: LoraSample[];
  // local trainer only
  localId?: string;
  step?: number;
  queuePosition?: number;
  localSamples?: string[];
};

export function isLoraDone(status: LoraStatus) {
  return ["succeeded", "failed", "canceled"].includes(status);
}

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "lora"
  );
}

const DEFAULT_LORA_STATE = {
  replicateToken: "",
  backend: "replicate" as LoraBackend,
  localUrl: DEFAULT_LOCAL_URL,
  jobs: [] as LoraJob[],
};

export const useLoraStore = createPersistStore(
  DEFAULT_LORA_STATE,
  (set, _get) => {
    function headers(json = true): Record<string, string> {
      const accessStore = useAccessStore.getState();
      let bearer = getBearerToken(_get().replicateToken);
      if (!bearer && accessStore.enabledAccessControl()) {
        bearer = getBearerToken(ACCESS_CODE_PREFIX + accessStore.accessCode);
      }
      const h: Record<string, string> = { Authorization: bearer };
      if (json) h["Content-Type"] = "application/json";
      return h;
    }

    async function api(path: string, init: RequestInit = {}) {
      const res = await fetch(`${ApiPath.Replicate}/${path}`, {
        ...init,
        headers: { ...headers(!(init.body instanceof FormData)) },
      });
      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { detail: text };
      }
      if (!res.ok) {
        throw new Error(
          data.detail || data.message || data.title || `HTTP ${res.status}`,
        );
      }
      return data;
    }

    function patchJob(id: string, patch: Partial<LoraJob>) {
      set({
        jobs: _get().jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
      });
    }

    function patchSample(
      jobId: string,
      sampleId: string,
      patch: Partial<LoraSample>,
    ) {
      set({
        jobs: _get().jobs.map((j) =>
          j.id !== jobId
            ? j
            : {
                ...j,
                samples: j.samples.map((s) =>
                  s.id === sampleId ? { ...s, ...patch } : s,
                ),
              },
        ),
      });
    }

    async function createDestination(name: string) {
      const account = await api("v1/account");
      const owner = account.username;
      const modelName = `${slugify(name)}-${nanoid(6).toLowerCase()}`;
      await api("v1/models", {
        method: "POST",
        body: JSON.stringify({
          owner,
          name: modelName,
          visibility: "private",
          hardware: "gpu-t4",
          description: `LoRA trained with LoRA Studio: ${name}`,
        }),
      });
      return `${owner}/${modelName}`;
    }

    async function local(path: string, init: RequestInit = {}) {
      const base = _get().localUrl.replace(/\/+$/, "");
      let res: Response;
      try {
        res = await fetch(`${base}/${path}`, init);
      } catch {
        throw new Error(
          `Can't reach the local trainer at ${base}. Is it running? (local-trainer/start.sh)`,
        );
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    }

    function fromLocal(j: any): Partial<LoraJob> {
      return {
        status: j.status,
        step: j.step,
        error: j.error ?? undefined,
        logs: j.log_tail,
        queuePosition: j.queue_position ?? undefined,
        weights: j.weights ?? undefined,
        localSamples: j.samples ?? [],
      };
    }

    const methods = {
      setBackend(backend: LoraBackend) {
        set({ backend });
      },

      setLocalUrl(url: string) {
        set({ localUrl: url.trim() || DEFAULT_LOCAL_URL });
      },

      localFileUrl(path: string) {
        return `${_get().localUrl.replace(/\/+$/, "")}/${path}`;
      },

      localHealth(): Promise<LocalHealth> {
        return local("health");
      },

      async localModels(): Promise<LocalModel[]> {
        return (await local("models")).models;
      },

      async downloadLocalModel(id: string) {
        await local(`models/${id}/download`, { method: "POST" });
      },

      async startLocalTraining(opts: {
        name: string;
        model: LocalModel;
        loraType: LoraType;
        triggerWord: string;
        steps: number;
        rank: number;
        lr: number;
        samplePrompts: string[];
        dataset: Blob;
        imageCount: number;
      }) {
        const job: LoraJob = {
          id: nanoid(),
          backend: "local",
          name: opts.name,
          modelId: opts.model.id,
          baseModel: opts.model.name,
          loraType: opts.loraType.name,
          trainer: "ai-toolkit",
          triggerWord: opts.triggerWord,
          steps: opts.steps,
          imageCount: opts.imageCount,
          createdAt: Date.now(),
          status: "uploading",
          samples: [],
        };
        set({ jobs: [job, ..._get().jobs] });

        try {
          const created = await local("jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: opts.name,
              model: opts.model.id,
              trigger_word: opts.triggerWord,
              // ai-toolkit replaces [trigger] with the trigger word
              default_caption: opts.loraType.caption("[trigger]"),
              steps: opts.steps,
              rank: opts.rank,
              lr: opts.lr,
              sample_prompts: opts.samplePrompts,
            }),
          });
          patchJob(job.id, { localId: created.id });
          const uploaded = await local(`jobs/${created.id}/dataset`, {
            method: "PUT",
            headers: { "Content-Type": "application/zip" },
            body: opts.dataset,
          });
          patchJob(job.id, fromLocal(uploaded));
        } catch (e: any) {
          patchJob(job.id, { status: "failed", error: e.message });
        }
      },

      setToken(token: string) {
        set({ replicateToken: token.trim() });
      },

      removeJob(id: string) {
        set({ jobs: _get().jobs.filter((j) => j.id !== id) });
      },

      async fetchTrainerSchema(trainer: string): Promise<TrainerSchema> {
        const model = await api(`v1/models/${trainer}`);
        const version = model.latest_version;
        const fields = parseSchema(version?.openapi_schema, "TrainingInput");
        if (!version || fields.length === 0) {
          throw new Error(`${trainer} does not support training`);
        }
        return { trainer, versionId: version.id, fields };
      },

      async startTraining(opts: {
        name: string;
        baseModel: BaseModel;
        loraType: LoraType;
        schema: TrainerSchema;
        triggerWord: string;
        steps: number;
        autocaption: boolean;
        overrides: Record<string, any>;
        dataset: Blob;
        imageCount: number;
      }) {
        const job: LoraJob = {
          id: nanoid(),
          name: opts.name,
          modelId: opts.baseModel.trainer ? opts.baseModel.id : undefined,
          baseModel: opts.baseModel.name,
          loraType: opts.loraType.name,
          trainer: opts.schema.trainer,
          triggerWord: opts.triggerWord,
          steps: opts.steps,
          imageCount: opts.imageCount,
          createdAt: Date.now(),
          status: "uploading",
          samples: [],
        };
        set({ jobs: [job, ..._get().jobs] });

        try {
          const form = new FormData();
          form.append("content", opts.dataset, "dataset.zip");
          const file = await api("v1/files", { method: "POST", body: form });

          const destination = await createDestination(opts.name);
          const input = buildTrainingInput(opts.schema, {
            datasetUrl: file.urls.get,
            triggerWord: opts.triggerWord,
            steps: opts.steps,
            autocaption: opts.autocaption,
            loraType: opts.loraType,
            overrides: opts.overrides,
          });
          const training = await api(
            `v1/models/${opts.schema.trainer}/versions/${opts.schema.versionId}/trainings`,
            {
              method: "POST",
              body: JSON.stringify({ destination, input }),
            },
          );
          patchJob(job.id, {
            status: training.status,
            trainingId: training.id,
            destination,
          });
        } catch (e: any) {
          patchJob(job.id, { status: "failed", error: e.message });
        }
      },

      async refreshJob(id: string) {
        const job = _get().jobs.find((j) => j.id === id);
        if (job?.localId) {
          try {
            patchJob(id, fromLocal(await local(`jobs/${job.localId}`)));
          } catch (e: any) {
            console.error("[LoRA] local refresh failed", e);
          }
          return;
        }
        if (!job?.trainingId) return;
        try {
          const t = await api(`v1/trainings/${job.trainingId}`);
          const output = t.output;
          patchJob(id, {
            status: t.status,
            logs: (t.logs as string | undefined)?.slice(-2000),
            error: t.error ?? undefined,
            version: output?.version,
            // trainers return either { weights } or a bare weights URL
            weights:
              output?.weights ??
              (typeof output === "string" ? output : undefined),
          });
        } catch (e: any) {
          console.error("[LoRA] refresh failed", e);
        }
      },

      async cancelJob(id: string) {
        const job = _get().jobs.find((j) => j.id === id);
        if (job?.localId) {
          patchJob(
            id,
            fromLocal(
              await local(`jobs/${job.localId}/cancel`, { method: "POST" }),
            ),
          );
          return;
        }
        if (!job?.trainingId) return;
        await api(`v1/trainings/${job.trainingId}/cancel`, { method: "POST" });
        await methods.refreshJob(id);
      },

      async generateSample(jobId: string, prompt: string) {
        const job = _get().jobs.find((j) => j.id === jobId);
        if (!job?.version || !job.destination) return;
        const sample: LoraSample = {
          id: nanoid(),
          prompt,
          status: "starting",
          images: [],
        };
        patchJob(jobId, { samples: [sample, ...job.samples] });

        try {
          // only send inputs the trained model actually accepts
          const model = await api(`v1/models/${job.destination}`);
          const accepted = new Set(
            parseSchema(model.latest_version?.openapi_schema, "Input").map(
              (f) => f.key,
            ),
          );
          const wanted: Record<string, any> = { prompt, num_outputs: 1 };
          const input = Object.fromEntries(
            Object.entries(wanted).filter(
              ([k]) => accepted.size === 0 || accepted.has(k),
            ),
          );

          // destination versions are "owner/model:hash"
          let p = await api("v1/predictions", {
            method: "POST",
            body: JSON.stringify({
              version: job.version.split(":").pop(),
              input,
            }),
          });
          while (!isLoraDone(p.status)) {
            await new Promise((r) => setTimeout(r, 3000));
            p = await api(`v1/predictions/${p.id}`);
          }
          patchSample(jobId, sample.id, {
            status: p.status,
            images: (Array.isArray(p.output) ? p.output : [p.output]).filter(
              Boolean,
            ),
            error: p.error ?? undefined,
          });
        } catch (e: any) {
          patchSample(jobId, sample.id, { status: "failed", error: e.message });
        }
      },
    };

    return methods;
  },
  {
    name: StoreKey.Lora,
    version: 3.0,
    migrate(state: any, version: number) {
      // v1 jobs were all trained on FLUX.1 dev
      if (version < 2) {
        state.jobs = (state.jobs ?? []).map((j: any) => ({
          baseModel: "FLUX.1 [dev]",
          loraType: "",
          trainer: "ostris/flux-dev-lora-trainer",
          ...j,
        }));
      }
      // v2 jobs only recorded the base model's display name
      if (version < 3) {
        const byName: Record<string, string> = {
          "FLUX.1 [dev]": "flux-dev",
          "FLUX.1 (fast trainer)": "flux-fast",
          "FLUX.1 [schnell]": "flux-schnell",
          "Stable Diffusion XL": "sdxl",
          "Qwen-Image": "qwen-image",
          HunyuanVideo: "hunyuan-video",
          "Wan 2.1 1.3B (video)": "wan21-1b",
        };
        state.jobs = (state.jobs ?? []).map((j: any) => ({
          modelId: byName[j.baseModel],
          ...j,
        }));
      }
      return state;
    },
  },
);
