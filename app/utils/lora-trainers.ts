export type BaseModel = {
  id: string;
  name: string;
  // Replicate "owner/name" of the trainer; empty for a user-entered trainer
  trainer: string;
  media: "image" | "video";
  note: string;
};

// Trainer inputs differ between models, so they're read from each trainer's
// live schema (see buildTrainingInput) rather than hard-coded here.
export const BASE_MODELS: BaseModel[] = [
  {
    id: "flux-dev",
    name: "FLUX.1 [dev]",
    trainer: "ostris/flux-dev-lora-trainer",
    media: "image",
    note: "Best all-round quality for people, products and styles.",
  },
  {
    id: "flux-fast",
    name: "FLUX.1 (fast trainer)",
    trainer: "replicate/fast-flux-trainer",
    media: "image",
    note: "Quicker and cheaper FLUX training with slightly less control.",
  },
  {
    id: "sdxl",
    name: "Stable Diffusion XL",
    trainer: "stability-ai/sdxl",
    media: "image",
    note: "Classic SDXL; works with the huge SDXL tool ecosystem.",
  },
  {
    id: "qwen-image",
    name: "Qwen-Image",
    trainer: "qwen/qwen-image-lora-trainer",
    media: "image",
    note: "Strong at illustration and text inside images. Prefers descriptive trigger words.",
  },
  {
    id: "hunyuan-video",
    name: "HunyuanVideo",
    trainer: "zsxkib/hunyuan-video-lora",
    media: "video",
    note: "Video LoRA. Train on short clips (or images) to get consistent motion and subjects.",
  },
  {
    id: "custom",
    name: "Custom Replicate trainer…",
    trainer: "",
    media: "image",
    note: "Any trainable Replicate model, e.g. owner/some-lora-trainer.",
  },
];

export type LoraType = {
  id: string;
  name: string;
  caption: (trigger: string) => string;
  // values to look for when a trainer exposes a lora_type/mode enum
  enumHints: string[];
  tips: string;
};

export const LORA_TYPES: LoraType[] = [
  {
    id: "person",
    name: "Person / character",
    caption: (t) => `a photo of ${t}`,
    enumHints: ["face", "person", "character", "subject"],
    tips: "Use 15–30 photos: close-ups and full body, different outfits, lighting and expressions.",
  },
  {
    id: "object",
    name: "Object / product / pet",
    caption: (t) => `a photo of ${t}`,
    enumHints: ["object", "subject", "concept"],
    tips: "Show the object from many angles and on different backgrounds.",
  },
  {
    id: "style",
    name: "Art style",
    caption: (t) => `an image in the style of ${t}`,
    enumHints: ["style"],
    tips: "Use 20–40 images sharing the style but with varied subjects.",
  },
  {
    id: "concept",
    name: "Concept / pose / effect",
    caption: (t) => t,
    enumHints: ["concept", "subject"],
    tips: "Every image should clearly show the concept; vary everything else.",
  },
];

export const LORA_PRESETS = [
  { name: "Quick", steps: 500 },
  { name: "Standard", steps: 1000 },
  { name: "High quality", steps: 2000 },
];

export type SchemaField = {
  key: string;
  type: "string" | "integer" | "number" | "boolean";
  description?: string;
  default?: any;
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
  format?: string;
  required: boolean;
};

export type TrainerSchema = {
  trainer: string;
  versionId: string;
  fields: SchemaField[];
};

// common settings -> the input names different trainers use for them
const ROLES = {
  dataset: [
    "input_images",
    "input_videos",
    "dataset",
    "images",
    "training_data",
    "instance_data",
  ],
  trigger: ["trigger_word", "token_string", "trigger", "instance_token"],
  steps: ["steps", "max_train_steps", "training_steps", "max_steps"],
  autocaption: ["autocaption", "auto_caption"],
  caption: [
    "default_caption",
    "caption_prefix",
    "autocaption_prefix",
    "instance_prompt",
  ],
  loraType: ["lora_type", "mode", "training_mode", "train_type"],
  face: ["use_face_detection_instead"],
};

export type Role = keyof typeof ROLES;

export function findRoleField(schema: TrainerSchema, role: Role) {
  for (const key of ROLES[role]) {
    const field = schema.fields.find((f) => f.key === key);
    if (field) return field;
  }
  if (role === "dataset") {
    return schema.fields.find((f) => f.format === "uri" && f.required);
  }
}

export function roleKeys(schema: TrainerSchema) {
  return new Set(
    (Object.keys(ROLES) as Role[])
      .map((r) => findRoleField(schema, r)?.key)
      .filter(Boolean) as string[],
  );
}

export function parseSchema(openapi: any, name: string) {
  const schemas = openapi?.components?.schemas ?? {};
  const input = schemas[name];
  if (!input?.properties) return [];
  const required = new Set<string>(input.required ?? []);
  return Object.entries<any>(input.properties)
    .sort(([, a], [, b]) => (a["x-order"] ?? 0) - (b["x-order"] ?? 0))
    .map(([key, prop]) => {
      // enums are emitted as allOf: [{ $ref: "#/components/schemas/x" }]
      const ref = prop.allOf?.[0]?.$ref?.split("/").pop();
      const enumDef = ref ? schemas[ref] : undefined;
      const type = enumDef?.type ?? prop.type ?? "string";
      return {
        key,
        type: ["integer", "number", "boolean"].includes(type) ? type : "string",
        description: prop.description,
        default: prop.default,
        enum: enumDef?.enum ?? prop.enum,
        minimum: prop.minimum,
        maximum: prop.maximum,
        format: prop.format,
        required: required.has(key),
      } as SchemaField;
    });
}

export function buildTrainingInput(
  schema: TrainerSchema,
  opts: {
    datasetUrl: string;
    triggerWord: string;
    steps: number;
    autocaption: boolean;
    loraType: LoraType;
    overrides: Record<string, any>;
  },
) {
  const input: Record<string, any> = {};
  const set = (role: Role, value: any) => {
    const field = findRoleField(schema, role);
    if (field && value !== undefined) input[field.key] = value;
  };

  set("dataset", opts.datasetUrl);
  set("trigger", opts.triggerWord);
  set("autocaption", opts.autocaption);
  set("caption", opts.loraType.caption(opts.triggerWord));
  set("face", opts.loraType.id === "person");

  const steps = findRoleField(schema, "steps");
  if (steps) {
    const max = steps.maximum ?? Infinity;
    const min = steps.minimum ?? 0;
    input[steps.key] = Math.min(max, Math.max(min, opts.steps));
  }

  const typeField = findRoleField(schema, "loraType");
  const match = typeField?.enum?.find((v) =>
    opts.loraType.enumHints.includes(String(v).toLowerCase()),
  );
  if (typeField && match !== undefined) input[typeField.key] = match;

  return { ...input, ...opts.overrides };
}
