// AI Companion server: zero dependencies, Node 18+.
// Serves the web UI, proxies LLM / TTS / STT / avatar calls so API keys stay server-side,
// and stores characters, user profiles and memories as JSON files in ./data.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./lib/store.js";
import { resolveProvider, chatRequest, chatJson } from "./lib/llm.js";
import { Push } from "./lib/push.js";
import { Calls } from "./lib/calls.js";
import { Auth } from "./lib/auth.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");

loadEnv(path.join(ROOT, ".env"));
const PORT = Number(process.env.PORT || 8787);
const providers = readJson("providers.json");
const store = new Store(process.env.DATA_DIR || path.join(ROOT, "data"));
const push = new Push(store, process.env.VAPID_SUBJECT);
const calls = new Calls(store, push, () => getCharacters());
const auth = new Auth(process.env.APP_PASSWORD, store);

// On a hosting platform, refuse to run wide open: anyone with the URL could spend your API credits and read memories.
const HOSTED = ["RAILWAY_ENVIRONMENT", "RENDER", "FLY_APP_NAME", "K_SERVICE"].some((k) => process.env[k]);
if (HOSTED && !auth.enabled && process.env.ALLOW_NO_PASSWORD !== "1") {
  console.error("Refusing to start: set APP_PASSWORD (or ALLOW_NO_PASSWORD=1 if something else protects this app).");
  process.exit(1);
}

const MAX_HISTORY = 40;
const MAX_FACTS = 200;
const MAX_BIOMETRIC_SAMPLES = 10;

// ---------- helpers ----------
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, name), "utf8"));
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw httpError(413, "Request body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  return JSON.parse((await readBody(req)).toString("utf8") || "{}");
}

async function upstreamError(r) {
  const text = await r.text().catch(() => "");
  return `${r.status} ${r.statusText}: ${text.slice(0, 500)}`;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".vrm": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".webmanifest": "application/manifest+json",
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.normalize(path.join(PUBLIC, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

// ---------- characters ----------
const HAIR_STYLES = ["none", "short", "long", "bun", "spiky", "curly"];
const TRAITS = ["warmth", "humor", "sarcasm", "energy", "curiosity", "formality"];

function hex(v, fallback) {
  return /^#[0-9a-f]{6}$/i.test(v || "") ? v : fallback;
}

function str(v, max = 2000) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** Fills defaults and clamps values so hand-edited or AI-generated characters are always usable. */
function normalizeCharacter(c = {}) {
  const look = c.look || {};
  const voice = c.voice || {};
  const traits = {};
  for (const t of TRAITS) traits[t] = Math.max(0, Math.min(10, Math.round(Number(c.traits?.[t] ?? 5))));
  return {
    id: str(c.id, 40) || Store.id(),
    name: str(c.name, 60) || "Unnamed",
    tagline: str(c.tagline, 120),
    personality: str(c.personality),
    backstory: str(c.backstory),
    speakingStyle: str(c.speakingStyle),
    likes: str(c.likes, 500),
    dislikes: str(c.dislikes, 500),
    rules: str(c.rules),
    greeting: str(c.greeting, 300),
    traits,
    look: {
      avatar: ["cartoon", "vrm", "simli"].includes(look.avatar) ? look.avatar : "cartoon",
      skin: hex(look.skin, "#f2c9a5"),
      hair: hex(look.hair, "#3b2a20"),
      hairStyle: HAIR_STYLES.includes(look.hairStyle) ? look.hairStyle : "short",
      eyes: hex(look.eyes, "#3d3d3d"),
      shirt: hex(look.shirt, "#7c5cff"),
      glasses: Boolean(look.glasses),
      vrmUrl: str(look.vrmUrl, 500),
      simliFaceId: str(look.simliFaceId, 100),
    },
    voice: { tts: str(voice.tts, 20), voice: str(voice.voice, 100) },
    calls: {
      mode: ["never", "sometimes", "daily"].includes(c.calls?.mode) ? c.calls.mode : "never",
      time: /^\d\d:\d\d$/.test(c.calls?.time || "") ? c.calls.time : "19:00",
      quietStart: /^\d\d:\d\d$/.test(c.calls?.quietStart || "") ? c.calls.quietStart : "22:30",
      quietEnd: /^\d\d:\d\d$/.test(c.calls?.quietEnd || "") ? c.calls.quietEnd : "08:00",
      tz: str(c.calls?.tz, 60),
    },
    updatedAt: Date.now(),
  };
}

function getCharacters() {
  let list = store.read("characters", null);
  if (!list) list = store.write("characters", readJson("characters.seed.json").map(normalizeCharacter));
  return list;
}

const CHARACTER_SCHEMA = `{
  "name": "first name",
  "tagline": "a few words, e.g. 'retired pirate who loves gardening'",
  "personality": "2-3 sentences",
  "backstory": "2-4 sentences",
  "speakingStyle": "how they talk: vocabulary, rhythm, catchphrases",
  "likes": "comma separated",
  "dislikes": "comma separated",
  "rules": "any extra behaviour rules, may be empty",
  "greeting": "the one sentence they say when a call starts",
  "traits": { ${TRAITS.map((t) => `"${t}": 0-10`).join(", ")} },
  "look": {
    "skin": "#hex", "hair": "#hex", "hairStyle": one of ${JSON.stringify(HAIR_STYLES)},
    "eyes": "#hex", "shirt": "#hex", "glasses": true|false
  }
}`;

async function generateCharacter(req, res) {
  const { description, base, instruction, provider, model } = await readJsonBody(req);
  const p = resolveProvider(providers, provider);
  const task = base
    ? `Here is an existing character as JSON:\n${JSON.stringify(base)}\n\nChange it according to this instruction, keeping everything else the same: "${str(instruction)}"`
    : `Create a new character from this description: "${str(description)}"`;
  const out = await chatJson(
    p,
    model,
    [
      {
        role: "system",
        content: `You design characters for an AI video-call companion app. The character will talk to the user live, out loud, so give them a vivid, specific personality and a distinctive way of speaking. Reply with ONLY a JSON object in exactly this shape:\n${CHARACTER_SCHEMA}`,
      },
      { role: "user", content: task },
    ],
    { temperature: 0.9 },
  );
  // Keep id / avatar / voice settings the user already chose when refining.
  const merged = base
    ? { ...base, ...out, id: base.id, look: { ...base.look, ...out.look, avatar: base.look?.avatar, vrmUrl: base.look?.vrmUrl, simliFaceId: base.look?.simliFaceId }, voice: base.voice, calls: base.calls }
    : { ...out, id: undefined };
  sendJson(res, 200, normalizeCharacter(merged));
}

async function saveCharacter(req, res) {
  const c = normalizeCharacter(await readJsonBody(req));
  const list = getCharacters();
  const i = list.findIndex((x) => x.id === c.id);
  if (i >= 0) list[i] = c;
  else list.push(c);
  store.write("characters", list);
  sendJson(res, 200, c);
}

function deleteCharacter(req, res, id) {
  const list = getCharacters().filter((c) => c.id !== id);
  if (!list.length) throw httpError(400, "Keep at least one character");
  store.write("characters", list);
  for (const f of fs.readdirSync(store.dir)) if (f.startsWith("rel_") && f.endsWith(`_${id}.json`)) fs.rmSync(path.join(store.dir, f));
  sendJson(res, 200, { ok: true });
}

// ---------- user profiles (name, face & voice prints) ----------
function getProfiles() {
  return store.read("profiles", []);
}

function createProfile(name) {
  const profiles = getProfiles();
  const p = { id: Store.id(), name: str(name, 60) || "Friend", faces: [], voices: [], createdAt: Date.now() };
  profiles.push(p);
  store.write("profiles", profiles);
  return p;
}

function vector(v, len) {
  return Array.isArray(v) && v.length === len && v.every(Number.isFinite) ? v.map((x) => Math.round(x * 1e5) / 1e5) : null;
}

async function updateProfile(req, res, id) {
  const body = await readJsonBody(req);
  const profiles = getProfiles();
  const p = profiles.find((x) => x.id === id);
  if (!p) throw httpError(404, "No such profile");
  if (body.name) p.name = str(body.name, 60);
  const face = vector(body.addFace, 128);
  if (face) p.faces = [...p.faces, face].slice(-MAX_BIOMETRIC_SAMPLES);
  const voice = Array.isArray(body.addVoice) ? vector(body.addVoice, body.addVoice.length) : null;
  if (voice) p.voices = [...p.voices, voice].slice(-MAX_BIOMETRIC_SAMPLES);
  if (body.clearFaces) p.faces = [];
  if (body.clearVoices) p.voices = [];
  store.write("profiles", profiles);
  sendJson(res, 200, p);
}

function deleteProfile(req, res, id) {
  store.write("profiles", getProfiles().filter((p) => p.id !== id));
  for (const f of fs.readdirSync(store.dir)) {
    if (f.startsWith(`facts_${id}.`) || f.startsWith(`rel_${id}_`)) fs.rmSync(path.join(store.dir, f));
  }
  sendJson(res, 200, { ok: true });
}

// ---------- memory ----------
// facts_<profile>            things about the person, shared by every character   (kind "about")
// rel_<profile>_<character>  that character's moments with them, relationship summary, recent chat (kind "moment")
// Each memory: { id, text, kind, core, source: "learned" | "you", createdAt, updatedAt }.
// Core memories always reach the prompt. Core memories and anything the user wrote or edited are
// locked: the automatic learner can add new memories but never changes or deletes locked ones.
const factsKey = (profile) => `facts_${profile}`;
const relKey = (profile, character) => `rel_${profile}_${character}`;
const MAX_MOMENTS = 200;
const KINDS = ["about", "moment"];

function toItem(m, kind) {
  if (typeof m === "string") m = { text: m }; // migrate old plain-text facts
  return {
    id: m.id || Store.id(),
    text: str(m.text, 400),
    kind,
    core: Boolean(m.core),
    source: m.source === "you" ? "you" : "learned",
    createdAt: m.createdAt || Date.now(),
    updatedAt: m.updatedAt || m.createdAt || Date.now(),
  };
}

function readFacts(profile) {
  const raw = store.read(factsKey(profile), { facts: [] }).facts;
  const facts = raw.map((f) => toItem(f, "about")).filter((f) => f.text);
  if (raw.some((f) => !f?.id)) store.write(factsKey(profile), { facts }); // persist migrated ids
  return facts;
}

function readRel(profile, character) {
  const rel = store.read(relKey(profile, character), {});
  return {
    summary: rel.summary || "",
    history: rel.history || [],
    lastSeen: rel.lastSeen || 0,
    calls: rel.calls || 0,
    moments: (rel.moments || []).map((m) => toItem(m, "moment")).filter((m) => m.text),
  };
}

// Old data had plain strings; give them ids once so edits can find them.
function migrateRel(profile, character) {
  const raw = store.read(relKey(profile, character), null);
  if (raw?.moments?.some((m) => !m?.id)) writeRel(profile, character, readRel(profile, character));
}

// Keep every core memory; trim the oldest regular ones past the cap.
function capped(items, max) {
  const regular = items.filter((m) => !m.core);
  const drop = new Set(regular.slice(0, Math.max(0, items.length - max)).map((m) => m.id));
  return items.filter((m) => !drop.has(m.id));
}

function writeFacts(profile, facts) {
  store.write(factsKey(profile), { facts: capped(facts, MAX_FACTS) });
}

function writeRel(profile, character, rel) {
  store.write(relKey(profile, character), { ...rel, moments: capped(rel.moments, MAX_MOMENTS) });
}

function getMemory(profile, character) {
  migrateRel(profile, character);
  return { facts: readFacts(profile), ...readRel(profile, character) };
}

function memoryParams(req) {
  const q = new URL(req.url, "http://x").searchParams;
  const profile = q.get("profile") || "guest";
  const character = q.get("character");
  if (!character) throw httpError(400, "character is required");
  return { profile, character, scope: q.get("scope") };
}

function readMemory(req, res) {
  const { profile, character } = memoryParams(req);
  sendJson(res, 200, getMemory(profile, character));
}

async function writeMemory(req, res) {
  const { profile = "guest", character, history, summary, callStarted } = await readJsonBody(req);
  if (!character) throw httpError(400, "character is required");
  const rel = readRel(profile, character);
  if (Array.isArray(history)) {
    rel.history = history
      .filter((m) => ["user", "assistant"].includes(m.role) && typeof m.content === "string")
      .slice(-MAX_HISTORY);
  }
  if (typeof summary === "string") rel.summary = str(summary);
  if (callStarted) rel.calls += 1;
  rel.lastSeen = Date.now();
  writeRel(profile, character, rel);
  sendJson(res, 200, getMemory(profile, character));
}

function forgetMemory(req, res) {
  const { profile, character, scope } = memoryParams(req);
  store.remove(relKey(profile, character));
  if (scope === "all") store.remove(factsKey(profile));
  sendJson(res, 200, getMemory(profile, character));
}

// --- single memories (the Memories page) ---
async function addMemoryItem(req, res) {
  const { profile = "guest", character, text, kind = "about", core = false } = await readJsonBody(req);
  if (!character || !KINDS.includes(kind)) throw httpError(400, "character and a valid kind are required");
  const item = toItem({ text, core, source: "you" }, kind);
  if (!item.text) throw httpError(400, "Memory text is empty");
  if (kind === "about") writeFacts(profile, [...readFacts(profile), item]);
  else {
    const rel = readRel(profile, character);
    rel.moments.push(item);
    writeRel(profile, character, rel);
  }
  sendJson(res, 200, getMemory(profile, character));
}

/** Edit text / core flag, or move a memory between "about" and "moment". */
async function updateMemoryItem(req, res, id) {
  const { profile = "guest", character, text, core, kind } = await readJsonBody(req);
  if (!character) throw httpError(400, "character is required");
  const facts = readFacts(profile);
  const rel = readRel(profile, character);
  const list = facts.some((f) => f.id === id) ? facts : rel.moments;
  const item = list.find((m) => m.id === id);
  if (!item) throw httpError(404, "No such memory");
  if (typeof text === "string") {
    if (!str(text)) throw httpError(400, "Memory text is empty");
    item.text = str(text, 400);
    item.source = "you";
  }
  if (typeof core === "boolean") item.core = core;
  item.updatedAt = Date.now();
  if (kind && KINDS.includes(kind) && kind !== item.kind) {
    list.splice(list.indexOf(item), 1);
    item.kind = kind;
    (kind === "about" ? facts : rel.moments).push(item);
  }
  writeFacts(profile, facts);
  writeRel(profile, character, rel);
  sendJson(res, 200, getMemory(profile, character));
}

function deleteMemoryItem(req, res, id) {
  const { profile, character } = memoryParams(req);
  writeFacts(profile, readFacts(profile).filter((f) => f.id !== id));
  const rel = readRel(profile, character);
  rel.moments = rel.moments.filter((m) => m.id !== id);
  writeRel(profile, character, rel);
  sendJson(res, 200, getMemory(profile, character));
}

/** Asks the LLM what it learned from recent turns, then merges it into memory. Core memories are never touched. */
async function learn(req, res) {
  const { profile = "guest", character: characterId, turns = [], provider, model } = await readJsonBody(req);
  const character = getCharacters().find((c) => c.id === characterId);
  if (!character) throw httpError(404, "No such character");
  const convo = turns
    .filter((m) => typeof m.content === "string")
    .map((m) => `${m.role === "user" ? "USER" : character.name.toUpperCase()}: ${m.content}`)
    .join("\n");
  if (!convo.trim()) return sendJson(res, 200, { memory: getMemory(profile, characterId) });

  const facts = readFacts(profile);
  const rel = readRel(profile, characterId);
  const locked = (m) => m.core || m.source === "you";
  const list = (items) => items.map((m) => `[${m.id}]${locked(m) ? " (LOCKED)" : ""} ${m.text}`).join("\n") || "(none)";
  const p = resolveProvider(providers, provider);
  const out = await chatJson(
    p,
    model,
    [
      {
        role: "system",
        content: `You maintain long-term memory for ${character.name}, an AI companion, about the human they talk to.
From the new conversation, pick out what's worth remembering next time:
- "about": durable facts about the USER (name, people and pets in their life, job, preferences, plans, health, feelings, values).
- "moment": notable things that happened between you two (a story they told, a joke you share, a promise, a celebration, a hard conversation).
Skip small talk and anything only the character said. Mark something "core" only if it is truly important to who they are or to your relationship (e.g. a loved one's name, a major life event, a deep fear or dream).
Never update or remove items marked (LOCKED); you may add a new item if something about them changed.
Reply with ONLY JSON:
{"user_name": "their first name if they said it, else null",
 "add": [{"text": "short, third person, e.g. 'Has a dog named Biscuit'", "kind": "about" | "moment", "core": true | false}],
 "update": [{"id": "existing id", "text": "corrected text"}],
 "remove": ["ids of unlocked items that are now wrong or duplicated"],
 "relationship_summary": "2-4 sentences, from ${character.name}'s point of view, about your relationship so far"}`,
      },
      {
        role: "user",
        content: `KNOWN ABOUT THEM:\n${list(facts)}\n\nMOMENTS YOU'VE SHARED:\n${list(rel.moments)}\n\nPREVIOUS RELATIONSHIP SUMMARY:\n${rel.summary || "(first conversation)"}\n\nNEW CONVERSATION:\n${convo}`,
      },
    ],
    { temperature: 0.2 },
  );

  const all = [...facts, ...rel.moments];
  const editable = (id) => all.find((m) => m.id === id && !locked(m));
  const remove = new Set((out.remove || []).map(String).filter(editable));
  for (const u of out.update || []) {
    const item = editable(String(u?.id));
    if (item && str(u.text)) Object.assign(item, { text: str(u.text, 400), source: "learned", updatedAt: Date.now() });
  }
  const newFacts = facts.filter((m) => !remove.has(m.id));
  rel.moments = rel.moments.filter((m) => !remove.has(m.id));
  const learned = [];
  for (const a of out.add || []) {
    const kind = KINDS.includes(a?.kind) ? a.kind : "about";
    const item = toItem({ text: typeof a === "string" ? a : a?.text, core: a?.core }, kind);
    const target = kind === "about" ? newFacts : rel.moments;
    if (item.text && !target.some((x) => x.text.toLowerCase() === item.text.toLowerCase())) {
      target.push(item);
      learned.push(item.text);
    }
  }
  if (out.relationship_summary) rel.summary = str(out.relationship_summary);

  let targetProfile = profile;
  let createdProfile = null;
  const userName = str(out.user_name, 60);
  if (profile === "guest" && userName && userName.toLowerCase() !== "null") {
    // A stranger told us their name: give them a profile and move what we learned onto it.
    createdProfile = createProfile(userName);
    targetProfile = createdProfile.id;
    store.remove(relKey("guest", characterId));
    store.remove(factsKey("guest"));
  }
  writeFacts(targetProfile, newFacts);
  writeRel(targetProfile, characterId, rel);

  sendJson(res, 200, { memory: getMemory(targetProfile, characterId), createdProfile, learned });
}

// ---------- LLM / voice / avatar proxies ----------
function getConfig(req, res) {
  sendJson(res, 200, {
    providers: Object.entries(providers).map(([id, p]) => ({
      id,
      name: p.name,
      models: p.models,
      configured: Boolean(p.apiKeyEnv ? process.env[p.apiKeyEnv] : true),
    })),
    tts: {
      elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
      openai: Boolean(process.env.TTS_BASE_URL),
    },
    stt: { server: Boolean(process.env.STT_BASE_URL) },
    simli: { configured: Boolean(process.env.SIMLI_API_KEY), faceId: process.env.SIMLI_FACE_ID || "" },
    vrmUrl: process.env.VRM_URL || "",
  });
}

async function listModels(req, res) {
  const p = resolveProvider(providers, new URL(req.url, "http://x").searchParams.get("provider"));
  const r = await fetch(`${p.baseURL}/models`, { headers: { Authorization: `Bearer ${p.key}` } });
  if (!r.ok) throw httpError(502, await upstreamError(r));
  const data = await r.json();
  const models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
  sendJson(res, 200, { models });
}

// Streams the reply back as plain text chunks (reasoning tokens are dropped).
async function chat(req, res) {
  const { provider, model, messages, temperature = 0.8, maxTokens = 400 } = await readJsonBody(req);
  const p = resolveProvider(providers, provider);

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  let r;
  try {
    r = await chatRequest(p, { model, messages, temperature, max_tokens: maxTokens, stream: true }, controller.signal);
  } catch (e) {
    if (controller.signal.aborted) return;
    throw httpError(502, String(e));
  }
  if (!r.ok) throw httpError(502, await upstreamError(r));

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) res.write(delta);
        } catch {
          // ignore keep-alives / partial lines
        }
      }
    }
  } catch (e) {
    if (!controller.signal.aborted) console.error("chat stream error:", e.message);
  }
  res.end();
}

async function tts(req, res) {
  const { text, provider, voice } = await readJsonBody(req);
  let r;
  if (provider === "elevenlabs") {
    const voiceId = voice || process.env.ELEVENLABS_VOICE_ID;
    if (!voiceId) throw httpError(400, "Set ELEVENLABS_VOICE_ID or give the character a voice ID");
    r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": process.env.ELEVENLABS_API_KEY },
        body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5" }),
      },
    );
  } else if (provider === "openai") {
    r = await fetch(`${process.env.TTS_BASE_URL}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TTS_API_KEY}` },
      body: JSON.stringify({
        model: process.env.TTS_MODEL || "tts-1",
        voice: voice || process.env.TTS_VOICE || "alloy",
        input: text,
        response_format: "mp3",
      }),
    });
  } else {
    throw httpError(400, "Unknown TTS provider");
  }
  if (!r.ok) throw httpError(502, await upstreamError(r));
  res.writeHead(200, { "Content-Type": r.headers.get("content-type") || "audio/mpeg" });
  res.end(Buffer.from(await r.arrayBuffer()));
}

async function stt(req, res) {
  if (!process.env.STT_BASE_URL) throw httpError(400, "Set STT_BASE_URL");
  const audio = await readBody(req);
  const type = req.headers["content-type"] || "audio/webm";
  const form = new FormData();
  form.append("file", new Blob([audio], { type }), type.includes("ogg") ? "speech.ogg" : "speech.webm");
  form.append("model", process.env.STT_MODEL || "whisper-1");
  const r = await fetch(`${process.env.STT_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.STT_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw httpError(502, await upstreamError(r));
  const data = await r.json();
  sendJson(res, 200, { text: data.text || "" });
}

// Mints a short-lived Simli session so the browser never sees SIMLI_API_KEY.
async function simliSession(req, res) {
  const apiKey = process.env.SIMLI_API_KEY;
  if (!apiKey) throw httpError(400, "Set SIMLI_API_KEY in companion/.env");
  const { faceId } = await readJsonBody(req);
  const headers = { "Content-Type": "application/json", "x-simli-api-key": apiKey };
  const tokenRes = await fetch("https://api.simli.ai/compose/token", {
    method: "POST",
    headers,
    body: JSON.stringify({
      faceId: faceId || process.env.SIMLI_FACE_ID,
      handleSilence: true,
      maxSessionLength: 3600,
      maxIdleTime: 300,
      model: "fasttalk",
    }),
  });
  if (!tokenRes.ok) throw httpError(502, await upstreamError(tokenRes));
  const { session_token } = await tokenRes.json();

  let iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];
  const iceRes = await fetch("https://api.simli.ai/compose/ice", { headers }).catch(() => null);
  if (iceRes?.ok) {
    const ice = await iceRes.json();
    if (Array.isArray(ice) && ice.length) iceServers = ice;
  }
  sendJson(res, 200, { sessionToken: session_token, iceServers });
}

// ---------- routing ----------
const routes = [
  ["GET", "/healthz", (req, res) => sendJson(res, 200, { ok: true })],
  ["POST", "/api/login", async (req, res) => {
    const { password } = await readJsonBody(req);
    if (!auth.enabled || auth.login(req, res, password || "")) return sendJson(res, 200, { ok: true });
    sendJson(res, 401, { error: "Wrong password" });
  }],
  ["POST", "/api/logout", (req, res) => (auth.logout(res), sendJson(res, 200, { ok: true }))],
  ["GET", "/api/config", getConfig],
  ["GET", "/api/models", listModels],
  ["POST", "/api/chat", chat],
  ["POST", "/api/tts", tts],
  ["POST", "/api/stt", stt],
  ["POST", "/api/simli/session", simliSession],
  ["GET", "/api/characters", (req, res) => sendJson(res, 200, getCharacters())],
  ["POST", "/api/characters", saveCharacter],
  ["POST", "/api/characters/generate", generateCharacter],
  ["DELETE", /^\/api\/characters\/([\w-]+)$/, deleteCharacter],
  ["GET", "/api/profiles", (req, res) => sendJson(res, 200, getProfiles())],
  ["POST", "/api/profiles", async (req, res) => sendJson(res, 200, createProfile((await readJsonBody(req)).name))],
  ["PUT", /^\/api\/profiles\/([\w-]+)$/, updateProfile],
  ["DELETE", /^\/api\/profiles\/([\w-]+)$/, deleteProfile],
  ["GET", "/api/memory", readMemory],
  ["PUT", "/api/memory", writeMemory],
  ["DELETE", "/api/memory", forgetMemory],
  ["POST", "/api/memory/learn", learn],
  ["POST", "/api/memory/items", addMemoryItem],
  ["PATCH", /^\/api\/memory\/items\/([\w-]+)$/, updateMemoryItem],
  ["DELETE", /^\/api\/memory\/items\/([\w-]+)$/, deleteMemoryItem],
  ["GET", "/api/push/key", (req, res) => sendJson(res, 200, { publicKey: push.publicKey })],
  ["POST", "/api/push/subscribe", async (req, res) => {
    const { subscription, profile } = await readJsonBody(req);
    push.subscribe(subscription, profile);
    sendJson(res, 200, { ok: true });
  }],
  ["POST", "/api/push/unsubscribe", async (req, res) => {
    push.unsubscribe((await readJsonBody(req)).endpoint);
    sendJson(res, 200, { ok: true });
  }],
  ["GET", "/api/calls/pending", (req, res) => sendJson(res, 200, { call: calls.pending() })],
  ["GET", "/api/calls/missed", (req, res) => {
    const id = new URL(req.url, "http://x").searchParams.get("character");
    sendJson(res, 200, { lastMissed: calls.lastMissed(id) });
  }],
  ["POST", "/api/calls/ring", async (req, res) => {
    const { character, delaySeconds = 0 } = await readJsonBody(req);
    if (!getCharacters().some((c) => c.id === character)) throw httpError(404, "No such character");
    if (delaySeconds > 0) calls.ringLater(character, Math.min(delaySeconds, 3600) * 1000);
    else await calls.ring(character);
    sendJson(res, 200, { ok: true, devices: push.subscriptions().length });
  }],
  ["POST", /^\/api\/calls\/([\w-]+)\/(answer|decline)$/, (req, res, id, action) => {
    sendJson(res, 200, { ok: calls.resolve(id, action === "answer") });
  }],
  ["POST", "/api/calls/seen", async (req, res) => {
    calls.clearMissed((await readJsonBody(req)).character);
    sendJson(res, 200, { ok: true });
  }],
];

function match(method, pathname) {
  for (const [m, p, handler] of routes) {
    if (m !== method) continue;
    if (typeof p === "string" && p === pathname) return [handler, []];
    const hit = typeof p !== "string" && pathname.match(p);
    if (hit) return [handler, hit.slice(1)];
  }
  return null;
}

async function handle(req, res) {
  const pathname = new URL(req.url, "http://x").pathname;
  if (!auth.isPublic(pathname) && !auth.isAuthed(req)) {
    if (pathname.startsWith("/api/")) return sendJson(res, 401, { error: "Sign in first" });
    res.writeHead(302, { Location: "/login.html" });
    return res.end();
  }
  const found = match(req.method, pathname);
  if (!found) return serveStatic(req, res);
  try {
    await found[0](req, res, ...found[1]);
  } catch (e) {
    if (!e.status) console.error(req.method, req.url, e);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: String(e.message || e) });
    else res.end();
  }
}

// Phones only allow camera, mic and push notifications over HTTPS.
// Set HTTPS_CERT + HTTPS_KEY (e.g. from mkcert) to serve HTTPS directly, or put a tunnel in front.
const tls = process.env.HTTPS_CERT && process.env.HTTPS_KEY;
const server = tls
  ? https.createServer({ cert: fs.readFileSync(process.env.HTTPS_CERT), key: fs.readFileSync(process.env.HTTPS_KEY) }, handle)
  : http.createServer(handle);
server.listen(PORT, () => console.log(`AI Companion running at ${tls ? "https" : "http"}://localhost:${PORT}`));
