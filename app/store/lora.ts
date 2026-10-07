import { ACCESS_CODE_PREFIX, ApiPath, StoreKey } from "@/app/constant";
import { getBearerToken } from "@/app/client/api";
import { createPersistStore } from "@/app/utils/store";
import { nanoid } from "nanoid";
import { useAccessStore } from "./access";

export const LORA_TRAINER = "ostris/flux-dev-lora-trainer";

export type LoraStatus =
  | "uploading"
  | "starting"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled";

export const LORA_PRESETS = [
  { name: "Quick (~10 min)", steps: 500 },
  { name: "Standard (~20 min)", steps: 1000 },
  { name: "High quality (~40 min)", steps: 2000 },
];

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

    async function ensureDestination(name: string) {
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

      async startTraining(opts: {
        name: string;
        triggerWord: string;
        steps: number;
        autocaption: boolean;
        dataset: Blob;
        imageCount: number;
      }) {
        const job: LoraJob = {
          id: nanoid(),
          name: opts.name,
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

          const destination = await ensureDestination(opts.name);
          const trainer = await api(`v1/models/${LORA_TRAINER}`);
          const training = await api(
            `v1/models/${LORA_TRAINER}/versions/${trainer.latest_version.id}/trainings`,
            {
              method: "POST",
              body: JSON.stringify({
                destination,
                input: {
                  input_images: file.urls.get,
                  trigger_word: opts.triggerWord,
                  steps: opts.steps,
                  autocaption: opts.autocaption,
                  lora_rank: 16,
                  learning_rate: 0.0004,
                },
              }),
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
          patchJob(id, {
            status: t.status,
            logs: (t.logs as string | undefined)?.slice(-2000),
            error: t.error ?? undefined,
            version: t.output?.version,
            weights: t.output?.weights,
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
        if (!job?.version) return;
        const sample: LoraSample = {
          id: nanoid(),
          prompt,
          status: "starting",
          images: [],
        };
        patchJob(jobId, { samples: [sample, ...job.samples] });

        try {
          // destination versions are "owner/model:hash"
          let p = await api("v1/predictions", {
            method: "POST",
            body: JSON.stringify({
              version: job.version.split(":").pop(),
              input: { prompt, num_outputs: 1, output_format: "png" },
            }),
          });
          while (!isLoraDone(p.status)) {
            await new Promise((r) => setTimeout(r, 2000));
            p = await api(`v1/predictions/${p.id}`);
          }
          patchSample(jobId, sample.id, {
            status: p.status,
            images: Array.isArray(p.output) ? p.output : [p.output],
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
    version: 1.0,
  },
);
