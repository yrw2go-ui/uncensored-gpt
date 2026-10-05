// AI Companion server: zero dependencies, Node 18+.
// Serves the web UI and proxies LLM / TTS / STT / avatar calls so API keys stay server-side.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");

loadEnv(path.join(ROOT, ".env"));
const PORT = Number(process.env.PORT || 8787);
const providers = readJson("providers.json");
const personas = readJson("personas.json");

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

function providerKey(p) {
  return p.apiKeyEnv ? process.env[p.apiKeyEnv] : "none";
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("Request body too large");
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

// ---------- API handlers ----------
function getConfig(req, res) {
  sendJson(res, 200, {
    providers: Object.entries(providers).map(([id, p]) => ({
      id,
      name: p.name,
      models: p.models,
      configured: Boolean(providerKey(p)),
    })),
    personas,
    tts: {
      elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
      openai: Boolean(process.env.TTS_BASE_URL),
      elevenlabsVoice: process.env.ELEVENLABS_VOICE_ID || "",
      openaiVoice: process.env.TTS_VOICE || "alloy",
    },
    stt: { server: Boolean(process.env.STT_BASE_URL) },
    simli: { configured: Boolean(process.env.SIMLI_API_KEY), faceId: process.env.SIMLI_FACE_ID || "" },
    vrmUrl: process.env.VRM_URL || "",
  });
}

async function listModels(req, res) {
  const id = new URL(req.url, "http://x").searchParams.get("provider");
  const p = providers[id];
  if (!p) return sendJson(res, 400, { error: "Unknown provider" });
  const r = await fetch(`${p.baseURL}/models`, {
    headers: { Authorization: `Bearer ${providerKey(p)}` },
  });
  if (!r.ok) return sendJson(res, 502, { error: await upstreamError(r) });
  const data = await r.json();
  const models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
  sendJson(res, 200, { models });
}

// Streams the reply back as plain text chunks (reasoning tokens are dropped).
async function chat(req, res) {
  const { provider, model, messages, temperature = 0.8, maxTokens = 400 } = await readJsonBody(req);
  const p = providers[provider];
  if (!p) return sendJson(res, 400, { error: "Unknown provider" });
  const key = providerKey(p);
  if (!key) return sendJson(res, 400, { error: `Set ${p.apiKeyEnv} in companion/.env` });

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  let r;
  try {
    r = await fetch(`${p.baseURL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true }),
    });
  } catch (e) {
    if (controller.signal.aborted) return;
    return sendJson(res, 502, { error: String(e) });
  }
  if (!r.ok) return sendJson(res, 502, { error: await upstreamError(r) });

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
    if (!voiceId) return sendJson(res, 400, { error: "Set ELEVENLABS_VOICE_ID or pick a voice" });
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
    return sendJson(res, 400, { error: "Unknown TTS provider" });
  }
  if (!r.ok) return sendJson(res, 502, { error: await upstreamError(r) });
  res.writeHead(200, { "Content-Type": r.headers.get("content-type") || "audio/mpeg" });
  res.end(Buffer.from(await r.arrayBuffer()));
}

async function stt(req, res) {
  if (!process.env.STT_BASE_URL) return sendJson(res, 400, { error: "Set STT_BASE_URL" });
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
  if (!r.ok) return sendJson(res, 502, { error: await upstreamError(r) });
  const data = await r.json();
  sendJson(res, 200, { text: data.text || "" });
}

// Mints a short-lived Simli session so the browser never sees SIMLI_API_KEY.
async function simliSession(req, res) {
  const apiKey = process.env.SIMLI_API_KEY;
  if (!apiKey) return sendJson(res, 400, { error: "Set SIMLI_API_KEY in companion/.env" });
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
  if (!tokenRes.ok) return sendJson(res, 502, { error: await upstreamError(tokenRes) });
  const { session_token } = await tokenRes.json();

  let iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];
  const iceRes = await fetch("https://api.simli.ai/compose/ice", { headers }).catch(() => null);
  if (iceRes?.ok) {
    const ice = await iceRes.json();
    if (Array.isArray(ice) && ice.length) iceServers = ice;
  }
  sendJson(res, 200, { sessionToken: session_token, iceServers });
}

const routes = {
  "GET /api/config": getConfig,
  "GET /api/models": listModels,
  "POST /api/chat": chat,
  "POST /api/tts": tts,
  "POST /api/stt": stt,
  "POST /api/simli/session": simliSession,
};

http
  .createServer(async (req, res) => {
    const route = routes[`${req.method} ${new URL(req.url, "http://x").pathname}`];
    if (!route) return serveStatic(req, res);
    try {
      await route(req, res);
    } catch (e) {
      console.error(req.url, e);
      if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
      else res.end();
    }
  })
  .listen(PORT, () => console.log(`AI Companion running at http://localhost:${PORT}`));
