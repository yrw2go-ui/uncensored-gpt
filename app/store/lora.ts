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
  "uploading" | "starting" | "processing" | "succeeded" | "failed" | "canceled";

export type LoraSample = {
  id: string;
  prompt: string;
  status: LoraStatus;
  images: string[];
  error?: string;
};

export type LoraJob = {
  id: string;
  name: string;
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

    const methods = {
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
    version: 2.0,
    migrate(state: any) {
      // v1 jobs were all trained on FLUX.1 dev
      state.jobs = (state.jobs ?? []).map((j: any) => ({
        baseModel: "FLUX.1 [dev]",
        loraType: "",
        trainer: "ostris/flux-dev-lora-trainer",
        ...j,
      }));
      return state;
    },
  },
);
