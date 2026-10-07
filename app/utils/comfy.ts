// Builds ComfyUI workflows that load a trained LoRA on its base model.
// Node settings and model file names follow the official ComfyUI examples
// (github.com/comfyanonymous/ComfyUI_examples).

type Ref = [nodeKey: string, slot: number];

type NodeDef = {
  inputs: [name: string, type: string][];
  outputs: [name: string, type: string][];
  widgets: string[];
};

const NODE_DEFS: Record<string, NodeDef> = {
  CheckpointLoaderSimple: {
    inputs: [],
    outputs: [
      ["MODEL", "MODEL"],
      ["CLIP", "CLIP"],
      ["VAE", "VAE"],
    ],
    widgets: ["ckpt_name"],
  },
  UNETLoader: {
    inputs: [],
    outputs: [["MODEL", "MODEL"]],
    widgets: ["unet_name", "weight_dtype"],
  },
  DualCLIPLoader: {
    inputs: [],
    outputs: [["CLIP", "CLIP"]],
    widgets: ["clip_name1", "clip_name2", "type"],
  },
  CLIPLoader: {
    inputs: [],
    outputs: [["CLIP", "CLIP"]],
    widgets: ["clip_name", "type"],
  },
  VAELoader: {
    inputs: [],
    outputs: [["VAE", "VAE"]],
    widgets: ["vae_name"],
  },
  LoraLoader: {
    inputs: [
      ["model", "MODEL"],
      ["clip", "CLIP"],
    ],
    outputs: [
      ["MODEL", "MODEL"],
      ["CLIP", "CLIP"],
    ],
    widgets: ["lora_name", "strength_model", "strength_clip"],
  },
  LoraLoaderModelOnly: {
    inputs: [["model", "MODEL"]],
    outputs: [["MODEL", "MODEL"]],
    widgets: ["lora_name", "strength_model"],
  },
  CLIPTextEncode: {
    inputs: [["clip", "CLIP"]],
    outputs: [["CONDITIONING", "CONDITIONING"]],
    widgets: ["text"],
  },
  FluxGuidance: {
    inputs: [["conditioning", "CONDITIONING"]],
    outputs: [["CONDITIONING", "CONDITIONING"]],
    widgets: ["guidance"],
  },
  ModelSamplingAuraFlow: {
    inputs: [["model", "MODEL"]],
    outputs: [["MODEL", "MODEL"]],
    widgets: ["shift"],
  },
  ModelSamplingSD3: {
    inputs: [["model", "MODEL"]],
    outputs: [["MODEL", "MODEL"]],
    widgets: ["shift"],
  },
  EmptyLatentImage: {
    inputs: [],
    outputs: [["LATENT", "LATENT"]],
    widgets: ["width", "height", "batch_size"],
  },
  EmptySD3LatentImage: {
    inputs: [],
    outputs: [["LATENT", "LATENT"]],
    widgets: ["width", "height", "batch_size"],
  },
  EmptyHunyuanLatentVideo: {
    inputs: [],
    outputs: [["LATENT", "LATENT"]],
    widgets: ["width", "height", "length", "batch_size"],
  },
  KSampler: {
    inputs: [
      ["model", "MODEL"],
      ["positive", "CONDITIONING"],
      ["negative", "CONDITIONING"],
      ["latent_image", "LATENT"],
    ],
    outputs: [["LATENT", "LATENT"]],
    widgets: ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
  },
  VAEDecode: {
    inputs: [
      ["samples", "LATENT"],
      ["vae", "VAE"],
    ],
    outputs: [["IMAGE", "IMAGE"]],
    widgets: [],
  },
  VAEDecodeTiled: {
    inputs: [
      ["samples", "LATENT"],
      ["vae", "VAE"],
    ],
    outputs: [["IMAGE", "IMAGE"]],
    widgets: ["tile_size", "overlap", "temporal_size", "temporal_overlap"],
  },
  SaveImage: {
    inputs: [["images", "IMAGE"]],
    outputs: [],
    widgets: ["filename_prefix"],
  },
  SaveAnimatedWEBP: {
    inputs: [["images", "IMAGE"]],
    outputs: [],
    widgets: ["filename_prefix", "fps", "lossless", "quality", "method"],
  },
};

type GraphNode = {
  key: string;
  type: string;
  widgets: any[];
  links: Record<string, Ref>;
};

class Graph {
  nodes: GraphNode[] = [];

  add(
    key: string,
    type: string,
    widgets: any[],
    links: Record<string, Ref> = {},
  ): string {
    if (!NODE_DEFS[type]) throw new Error(`unknown node ${type}`);
    this.nodes.push({ key, type, widgets, links });
    return key;
  }

  // ComfyUI's API ("prompt") format, for /prompt or scripts
  toApi() {
    const ids = new Map(this.nodes.map((n, i) => [n.key, String(i + 1)]));
    return Object.fromEntries(
      this.nodes.map((n) => {
        const def = NODE_DEFS[n.type];
        const inputs: Record<string, any> = {};
        def.widgets.forEach((w, i) => (inputs[w] = n.widgets[i]));
        for (const [name, [from, slot]] of Object.entries(n.links)) {
          inputs[name] = [ids.get(from)!, slot];
        }
        return [ids.get(n.key)!, { class_type: n.type, inputs }];
      }),
    );
  }

  // ComfyUI's UI workflow format, loadable by drag and drop
  toWorkflow() {
    const ids = new Map(this.nodes.map((n, i) => [n.key, i + 1]));
    const links: [number, number, number, number, number, string][] = [];

    // lay nodes out left to right by dependency depth
    const depth = new Map<string, number>();
    const depthOf = (key: string): number => {
      if (depth.has(key)) return depth.get(key)!;
      const node = this.nodes.find((n) => n.key === key)!;
      const d = Math.max(
        0,
        ...Object.values(node.links).map(([from]) => depthOf(from) + 1),
      );
      depth.set(key, d);
      return d;
    };
    const rows = new Map<number, number>();

    const nodes = this.nodes.map((n, order) => {
      const def = NODE_DEFS[n.type];
      const d = depthOf(n.key);
      const row = rows.get(d) ?? 0;
      rows.set(d, row + 1);

      const inputs = def.inputs.map(([name, type], toSlot) => {
        const ref = n.links[name];
        if (!ref) return { name, type, link: null };
        const id = links.length + 1;
        links.push([
          id,
          ids.get(ref[0])!,
          ref[1],
          ids.get(n.key)!,
          toSlot,
          type,
        ]);
        return { name, type, link: id };
      });

      // KSampler's seed is followed by the UI-only "control after generate"
      const widgets_values =
        n.type === "KSampler"
          ? [n.widgets[0], "randomize", ...n.widgets.slice(1)]
          : n.widgets;

      return {
        id: ids.get(n.key)!,
        type: n.type,
        pos: [40 + d * 380, 40 + row * 220],
        size: [340, n.type === "CLIPTextEncode" ? 160 : 110],
        flags: {},
        order,
        mode: 0,
        inputs,
        outputs: def.outputs.map(([name, type], slot_index) => ({
          name,
          type,
          slot_index,
          links: [] as number[],
        })),
        properties: { "Node name for S&R": n.type },
        widgets_values,
      };
    });

    for (const [id, from, slot] of links) {
      nodes[from - 1].outputs[slot].links.push(id);
    }

    return {
      last_node_id: nodes.length,
      last_link_id: links.length,
      nodes,
      links,
      groups: [],
      config: {},
      extra: {},
      version: 0.4,
    };
  }
}

export type ComfyModelFile = {
  file: string;
  folder: string;
  url: string;
};

export type ComfyTemplate = {
  id: string;
  name: string;
  video: boolean;
  files: ComfyModelFile[];
  build: (g: Graph, lora: string, prompt: string, seed: number) => void;
};

const FLUX_TEXT_ENCODERS: ComfyModelFile[] = [
  {
    file: "clip_l.safetensors",
    folder: "models/text_encoders",
    url: "https://huggingface.co/comfyanonymous/flux_text_encoders/tree/main",
  },
  {
    file: "t5xxl_fp16.safetensors",
    folder: "models/text_encoders",
    url: "https://huggingface.co/comfyanonymous/flux_text_encoders/tree/main",
  },
  {
    file: "ae.safetensors",
    folder: "models/vae",
    url: "https://huggingface.co/Comfy-Org/Lumina_Image_2.0_Repackaged/blob/main/split_files/vae/ae.safetensors",
  },
];

function flux(unet: string, steps: number) {
  return (g: Graph, lora: string, prompt: string, seed: number) => {
    g.add("unet", "UNETLoader", [unet, "default"]);
    g.add("clip", "DualCLIPLoader", [
      "clip_l.safetensors",
      "t5xxl_fp16.safetensors",
      "flux",
    ]);
    g.add("vae", "VAELoader", ["ae.safetensors"]);
    g.add("lora", "LoraLoader", [lora, 1, 1], {
      model: ["unet", 0],
      clip: ["clip", 0],
    });
    g.add("pos", "CLIPTextEncode", [prompt], { clip: ["lora", 1] });
    g.add("neg", "CLIPTextEncode", [""], { clip: ["lora", 1] });
    g.add("guidance", "FluxGuidance", [3.5], { conditioning: ["pos", 0] });
    g.add("latent", "EmptySD3LatentImage", [1024, 1024, 1]);
    g.add("sampler", "KSampler", [seed, steps, 1, "euler", "simple", 1], {
      model: ["lora", 0],
      positive: ["guidance", 0],
      negative: ["neg", 0],
      latent_image: ["latent", 0],
    });
    g.add("decode", "VAEDecode", [], {
      samples: ["sampler", 0],
      vae: ["vae", 0],
    });
    g.add("save", "SaveImage", ["lora_studio"], { images: ["decode", 0] });
  };
}

export const COMFY_TEMPLATES: ComfyTemplate[] = [
  {
    id: "flux-dev",
    name: "FLUX.1 [dev]",
    video: false,
    files: [
      {
        file: "flux1-dev.safetensors",
        folder: "models/diffusion_models",
        url: "https://huggingface.co/black-forest-labs/FLUX.1-dev",
      },
      ...FLUX_TEXT_ENCODERS,
    ],
    build: flux("flux1-dev.safetensors", 20),
  },
  {
    id: "flux-schnell",
    name: "FLUX.1 [schnell]",
    video: false,
    files: [
      {
        file: "flux1-schnell.safetensors",
        folder: "models/diffusion_models",
        url: "https://huggingface.co/black-forest-labs/FLUX.1-schnell",
      },
      ...FLUX_TEXT_ENCODERS,
    ],
    build: flux("flux1-schnell.safetensors", 4),
  },
  {
    id: "sdxl",
    name: "Stable Diffusion XL",
    video: false,
    files: [
      {
        file: "sd_xl_base_1.0.safetensors",
        folder: "models/checkpoints",
        url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/sd_xl_base_1.0.safetensors",
      },
    ],
    build(g, lora, prompt, seed) {
      g.add("ckpt", "CheckpointLoaderSimple", ["sd_xl_base_1.0.safetensors"]);
      g.add("lora", "LoraLoader", [lora, 1, 1], {
        model: ["ckpt", 0],
        clip: ["ckpt", 1],
      });
      g.add("pos", "CLIPTextEncode", [prompt], { clip: ["lora", 1] });
      g.add("neg", "CLIPTextEncode", ["blurry, low quality, deformed"], {
        clip: ["lora", 1],
      });
      g.add("latent", "EmptyLatentImage", [1024, 1024, 1]);
      g.add("sampler", "KSampler", [seed, 30, 7, "dpmpp_2m", "karras", 1], {
        model: ["lora", 0],
        positive: ["pos", 0],
        negative: ["neg", 0],
        latent_image: ["latent", 0],
      });
      g.add("decode", "VAEDecode", [], {
        samples: ["sampler", 0],
        vae: ["ckpt", 2],
      });
      g.add("save", "SaveImage", ["lora_studio"], { images: ["decode", 0] });
    },
  },
  {
    id: "qwen-image",
    name: "Qwen-Image",
    video: false,
    files: [
      {
        file: "qwen_image_fp8_e4m3fn.safetensors",
        folder: "models/diffusion_models",
        url: "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/blob/main/split_files/diffusion_models/qwen_image_fp8_e4m3fn.safetensors",
      },
      {
        file: "qwen_2.5_vl_7b_fp8_scaled.safetensors",
        folder: "models/text_encoders",
        url: "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/blob/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
      },
      {
        file: "qwen_image_vae.safetensors",
        folder: "models/vae",
        url: "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/blob/main/split_files/vae/qwen_image_vae.safetensors",
      },
    ],
    build(g, lora, prompt, seed) {
      g.add("unet", "UNETLoader", [
        "qwen_image_fp8_e4m3fn.safetensors",
        "default",
      ]);
      g.add("clip", "CLIPLoader", [
        "qwen_2.5_vl_7b_fp8_scaled.safetensors",
        "qwen_image",
      ]);
      g.add("vae", "VAELoader", ["qwen_image_vae.safetensors"]);
      g.add("lora", "LoraLoaderModelOnly", [lora, 1], { model: ["unet", 0] });
      g.add("shift", "ModelSamplingAuraFlow", [3.1], { model: ["lora", 0] });
      g.add("pos", "CLIPTextEncode", [prompt], { clip: ["clip", 0] });
      g.add("neg", "CLIPTextEncode", [""], { clip: ["clip", 0] });
      g.add("latent", "EmptySD3LatentImage", [1328, 1328, 1]);
      g.add("sampler", "KSampler", [seed, 20, 2.5, "euler", "simple", 1], {
        model: ["shift", 0],
        positive: ["pos", 0],
        negative: ["neg", 0],
        latent_image: ["latent", 0],
      });
      g.add("decode", "VAEDecode", [], {
        samples: ["sampler", 0],
        vae: ["vae", 0],
      });
      g.add("save", "SaveImage", ["lora_studio"], { images: ["decode", 0] });
    },
  },
  {
    id: "wan21-1b",
    name: "Wan 2.1 1.3B",
    video: true,
    files: [
      {
        file: "wan2.1_t2v_1.3B_fp16.safetensors",
        folder: "models/diffusion_models",
        url: "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/tree/main/split_files/diffusion_models",
      },
      {
        file: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        folder: "models/text_encoders",
        url: "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/tree/main/split_files/text_encoders",
      },
      {
        file: "wan_2.1_vae.safetensors",
        folder: "models/vae",
        url: "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/tree/main/split_files/vae",
      },
    ],
    build(g, lora, prompt, seed) {
      g.add("unet", "UNETLoader", [
        "wan2.1_t2v_1.3B_fp16.safetensors",
        "default",
      ]);
      g.add("clip", "CLIPLoader", [
        "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        "wan",
      ]);
      g.add("vae", "VAELoader", ["wan_2.1_vae.safetensors"]);
      g.add("lora", "LoraLoaderModelOnly", [lora, 1], { model: ["unet", 0] });
      g.add("shift", "ModelSamplingSD3", [8], { model: ["lora", 0] });
      g.add("pos", "CLIPTextEncode", [prompt], { clip: ["clip", 0] });
      g.add("neg", "CLIPTextEncode", ["blurry, static, low quality"], {
        clip: ["clip", 0],
      });
      g.add("latent", "EmptyHunyuanLatentVideo", [832, 480, 33, 1]);
      g.add("sampler", "KSampler", [seed, 30, 6, "uni_pc", "simple", 1], {
        model: ["shift", 0],
        positive: ["pos", 0],
        negative: ["neg", 0],
        latent_image: ["latent", 0],
      });
      g.add("decode", "VAEDecode", [], {
        samples: ["sampler", 0],
        vae: ["vae", 0],
      });
      g.add(
        "save",
        "SaveAnimatedWEBP",
        ["lora_studio", 16, false, 90, "default"],
        {
          images: ["decode", 0],
        },
      );
    },
  },
  {
    id: "hunyuan-video",
    name: "HunyuanVideo",
    video: true,
    files: [
      {
        file: "hunyuan_video_t2v_720p_bf16.safetensors",
        folder: "models/diffusion_models",
        url: "https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/tree/main/split_files/diffusion_models",
      },
      {
        file: "clip_l.safetensors",
        folder: "models/text_encoders",
        url: "https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/tree/main/split_files/text_encoders",
      },
      {
        file: "llava_llama3_fp8_scaled.safetensors",
        folder: "models/text_encoders",
        url: "https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/tree/main/split_files/text_encoders",
      },
      {
        file: "hunyuan_video_vae_bf16.safetensors",
        folder: "models/vae",
        url: "https://huggingface.co/Comfy-Org/HunyuanVideo_repackaged/tree/main/split_files/vae",
      },
    ],
    build(g, lora, prompt, seed) {
      g.add("unet", "UNETLoader", [
        "hunyuan_video_t2v_720p_bf16.safetensors",
        "default",
      ]);
      g.add("clip", "DualCLIPLoader", [
        "clip_l.safetensors",
        "llava_llama3_fp8_scaled.safetensors",
        "hunyuan_video",
      ]);
      g.add("vae", "VAELoader", ["hunyuan_video_vae_bf16.safetensors"]);
      g.add("lora", "LoraLoaderModelOnly", [lora, 1], { model: ["unet", 0] });
      g.add("shift", "ModelSamplingSD3", [7], { model: ["lora", 0] });
      g.add("pos", "CLIPTextEncode", [prompt], { clip: ["clip", 0] });
      g.add("neg", "CLIPTextEncode", [""], { clip: ["clip", 0] });
      g.add("guidance", "FluxGuidance", [6], { conditioning: ["pos", 0] });
      g.add("latent", "EmptyHunyuanLatentVideo", [848, 480, 33, 1]);
      g.add("sampler", "KSampler", [seed, 20, 1, "euler", "simple", 1], {
        model: ["shift", 0],
        positive: ["guidance", 0],
        negative: ["neg", 0],
        latent_image: ["latent", 0],
      });
      // tiled decode keeps VRAM use manageable for video
      g.add("decode", "VAEDecodeTiled", [256, 64, 64, 8], {
        samples: ["sampler", 0],
        vae: ["vae", 0],
      });
      g.add(
        "save",
        "SaveAnimatedWEBP",
        ["lora_studio", 24, false, 80, "default"],
        {
          images: ["decode", 0],
        },
      );
    },
  },
];

// LoRA Studio base model ids (cloud and local) -> ComfyUI template
const TEMPLATE_FOR_MODEL: Record<string, string> = {
  "flux-dev": "flux-dev",
  "flux-fast": "flux-dev",
  "flux-schnell": "flux-schnell",
  sdxl: "sdxl",
  "qwen-image": "qwen-image",
  "wan21-1b": "wan21-1b",
  "hunyuan-video": "hunyuan-video",
};

export function comfyTemplateFor(modelId?: string) {
  const id = modelId && TEMPLATE_FOR_MODEL[modelId];
  return COMFY_TEMPLATES.find((t) => t.id === id);
}

export function buildComfyWorkflow(
  template: ComfyTemplate,
  loraFile: string,
  prompt: string,
  seed = Math.floor(Math.random() * 2 ** 32),
) {
  const g = new Graph();
  template.build(g, loraFile, prompt, seed);
  return { workflow: g.toWorkflow(), api: g.toApi() };
}

export function comfyReadme(opts: {
  template: ComfyTemplate;
  loraName: string;
  loraFile: string;
  cloudSdxl: boolean;
  triggerWord: string;
  prompt: string;
  workflowFile: string;
}) {
  const { template } = opts;
  const lines = [
    `${opts.loraName}: ComfyUI workflow (${template.name})`,
    "",
    "1. Copy the ComfyUI folder from this zip over your ComfyUI install.",
    `   That puts the LoRA at ComfyUI/models/loras/${opts.loraFile}`,
    "",
    `2. Make sure ComfyUI has the ${template.name} base model files:`,
    ...template.files.map(
      (f) => `   - ComfyUI/${f.folder}/${f.file}\n     ${f.url}`,
    ),
    "",
    `3. Drag ${opts.workflowFile} onto the ComfyUI window and press Run.`,
    "",
    `Prompt: "${opts.prompt}"`,
    `Use the trigger word "${opts.triggerWord}" in your prompts to activate the LoRA.`,
    "Lower the LoRA strength (0.6-0.9) if results look overcooked.",
  ];
  if (opts.cloudSdxl) {
    lines.push(
      "",
      "Note: Replicate's SDXL trainer also learns token embeddings, which ComfyUI's",
      "LoRA loader doesn't use. Describe the subject in words alongside the",
      "trigger word for best results.",
    );
  }
  return lines.join("\n") + "\n";
}
