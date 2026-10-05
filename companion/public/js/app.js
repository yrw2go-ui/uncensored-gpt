// Orchestrates the call: mic -> STT -> LLM (streamed) -> sentence queue -> TTS -> avatar.
import { Speaker, Listener } from "./speech.js";
import { CartoonAvatar } from "./avatars/cartoon.js";

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => {
    try {
      return JSON.parse(localStorage.getItem(`companion.${k}`)) ?? d;
    } catch {
      return d;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(`companion.${k}`, JSON.stringify(v));
    } catch {}
  },
};

const MAX_HISTORY = 40; // messages kept as short-term memory

let config;
let settings = store.get("settings", {});
let history = store.get("history", []);
let avatar = null;
let avatarType = "cartoon";
let state = "idle";
let inCall = false;
let micMuted = false;
let camStream = null;
let reply = null; // { controller, text } for the in-flight answer

const speaker = new Speaker({
  getAvatar: () => avatar,
  onStart: () => setState("speaking"),
  onEnd: () => setState(reply ? "thinking" : inCall ? "listening" : "idle"),
  onError: (e) => showError(e.message),
});

const listener = new Listener({
  onSpeechStart: () => {
    if ($("chk-bargein").checked && (speaker.speaking || reply)) interrupt();
  },
  onInterim: (text) => ($("caption").textContent = `“${text}”`),
  onFinal: (text) => {
    $("caption").textContent = "";
    userSaid(text);
  },
  onError: (e) => showError(e.message),
});

// ---------- UI helpers ----------
function setState(s) {
  state = s;
  $("state-dot").className = `dot ${s}`;
}

function showError(msg) {
  console.error(msg);
  addMessage("error", msg);
  const el = $("stage-msg");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(showError.t);
  showError.t = setTimeout(() => (el.hidden = true), 6000);
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  $("transcript").appendChild(div);
  $("transcript").scrollTop = 1e9;
  return div;
}

function renderHistory() {
  $("transcript").innerHTML = "";
  for (const m of history) addMessage(m.role, typeof m.content === "string" ? m.content : m.text || "");
}

function saveSettings() {
  settings = {
    provider: $("sel-provider").value,
    model: $("inp-model").value,
    persona: $("sel-persona").value,
    prompt: $("inp-prompt").value,
    temperature: Number($("inp-temp").value),
    vision: $("chk-vision").checked,
    avatar: avatarType,
    vrmUrl: $("inp-vrm").value,
    faceId: $("inp-face").value,
    tts: $("sel-tts").value,
    voice: $("inp-voice").value,
    stt: $("sel-stt").value,
    bargeIn: $("chk-bargein").checked,
  };
  store.set("settings", settings);
}

function fillSelect(sel, items, value) {
  sel.innerHTML = "";
  for (const { value: v, label, disabled } of items) {
    const o = new Option(label, v);
    o.disabled = Boolean(disabled);
    sel.add(o);
  }
  if (value && [...sel.options].some((o) => o.value === value && !o.disabled)) sel.value = value;
}

function currentPersona() {
  return config.personas.find((p) => p.id === $("sel-persona").value) || config.personas[0];
}

// ---------- Avatars ----------
async function setAvatar(type, opts = {}) {
  document.querySelectorAll("#seg-avatar button").forEach((b) => b.classList.toggle("on", b.dataset.v === type));
  document.querySelectorAll("[data-for]").forEach((el) => (el.hidden = el.dataset.for !== type));

  if (type === "simli" && $("sel-tts").value === "browser") {
    const serverVoice = [...$("sel-tts").options].find((o) => o.value !== "browser" && !o.disabled);
    if (!serverVoice) {
      showError("Photoreal needs a server voice: set ELEVENLABS_API_KEY or TTS_BASE_URL in companion/.env.");
      return setAvatar("cartoon");
    }
    $("sel-tts").value = serverVoice.value;
    speaker.provider = serverVoice.value;
  }

  speaker.stop();
  avatar?.destroy();
  avatar = null;
  const root = $("avatar-root");
  root.innerHTML = "";
  avatarType = type;
  saveSettings();

  try {
    let next;
    if (type === "vrm") {
      const { VrmAvatar } = await import("./avatars/vrm.js");
      next = new VrmAvatar({ url: opts.url || $("inp-vrm").value || config.vrmUrl });
    } else if (type === "simli") {
      const { SimliAvatar } = await import("./avatars/simli.js");
      next = new SimliAvatar({ faceId: $("inp-face").value || config.simli.faceId });
    } else {
      next = new CartoonAvatar({ color: currentPersona()?.cartoonColor });
    }
    await next.mount(root);
    if (avatarType !== type) return next.destroy(); // user switched again while loading
    avatar = next;
  } catch (e) {
    showError(`Could not load ${type} avatar: ${e.message || e}`);
    if (type !== "cartoon") return setAvatar("cartoon");
  }
}

function animate() {
  avatar?.update?.(speaker.level(), state);
  requestAnimationFrame(animate);
}

// ---------- Conversation ----------
function snapshot() {
  const v = $("self-video");
  if (!camStream || !v.videoWidth) return null;
  const c = document.createElement("canvas");
  const scale = 512 / Math.max(v.videoWidth, v.videoHeight);
  c.width = v.videoWidth * scale;
  c.height = v.videoHeight * scale;
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.7);
}

function userSaid(text) {
  if (!text.trim()) return;
  if (reply || speaker.speaking) interrupt();
  history.push({ role: "user", content: text });
  addMessage("user", text);
  respond();
}

function buildMessages(extraUser) {
  const msgs = [{ role: "system", content: $("inp-prompt").value }];
  const recent = history.slice(-MAX_HISTORY);
  recent.forEach((m, i) => {
    const last = i === recent.length - 1 && m.role === "user";
    const image = last && !extraUser && $("chk-vision").checked ? snapshot() : null;
    msgs.push(
      image
        ? { role: "user", content: [{ type: "text", text: m.content }, { type: "image_url", image_url: { url: image } }] }
        : { role: m.role, content: m.content },
    );
  });
  if (extraUser) msgs.push({ role: "user", content: extraUser });
  return msgs;
}

/** Splits streamed text into speakable sentences and hides <think> reasoning blocks. */
class SentenceSplitter {
  constructor(onSentence) {
    this.onSentence = onSentence;
    this.raw = "";
    this.spoken = 0; // index into visible text already sent to TTS
  }
  visible() {
    return this.raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").replace(/[*_#`]/g, "");
  }
  push(chunk) {
    this.raw += chunk;
    const text = this.visible();
    const rest = text.slice(this.spoken);
    const re = /[.!?…]+["')\]]?(\s|$)|\n+/g;
    let m;
    let cut = 0;
    while ((m = re.exec(rest)) && m.index + m[0].length < rest.length) cut = m.index + m[0].length;
    if (!cut && rest.length > 180) cut = rest.lastIndexOf(", ", 180) + 1; // very long sentence: split at a comma
    if (cut > 0) {
      this.onSentence(rest.slice(0, cut));
      this.spoken += cut;
    }
    return text;
  }
  flush() {
    const text = this.visible();
    const rest = text.slice(this.spoken);
    this.spoken = text.length;
    if (rest.trim()) this.onSentence(rest);
    return text.trim();
  }
}

async function respond(extraUser) {
  const controller = new AbortController();
  const bubble = addMessage("assistant", "…");
  const splitter = new SentenceSplitter((s) => speaker.say(s));
  const current = { controller, text: "", bubble, splitter };
  reply = current;
  setState("thinking");
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: $("sel-provider").value,
        model: $("inp-model").value.trim(),
        temperature: Number($("inp-temp").value),
        messages: buildMessages(extraUser),
      }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Chat failed (${r.status})`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      current.text = splitter.push(dec.decode(value, { stream: true }));
      bubble.textContent = current.text || "…";
      $("caption").textContent = current.text.slice(-160);
    }
    current.text = splitter.flush();
    bubble.textContent = current.text || "(no reply)";
    if (current.text) history.push({ role: "assistant", content: current.text });
  } catch (e) {
    if (e.name !== "AbortError") {
      bubble.remove();
      showError(e.message);
    }
  } finally {
    store.set("history", history.slice(-MAX_HISTORY));
    if (reply === current) {
      reply = null;
      if (!speaker.speaking) setState(inCall ? "listening" : "idle");
    }
    setTimeout(() => !speaker.speaking && ($("caption").textContent = ""), 1500);
  }
}

function interrupt() {
  if (reply) {
    // Keep what was already said so the model knows it got cut off.
    const partial = reply.splitter.visible().trim();
    if (partial) history.push({ role: "assistant", content: `${partial} —` });
    reply.bubble.textContent = partial ? `${partial} —` : "(interrupted)";
    reply.controller.abort();
    reply = null;
  }
  speaker.stop();
  $("caption").textContent = "";
}

// ---------- Call controls ----------
async function startCall() {
  speaker.unlock();
  try {
    await listener.start($("sel-stt").value);
  } catch (e) {
    return showError(`Microphone: ${e.message}`);
  }
  inCall = true;
  micMuted = false;
  $("btn-call").textContent = "End call";
  $("btn-call").className = "btn danger";
  $("btn-mic").disabled = false;
  $("btn-mic").textContent = "🎤 Mic on";
  setState("listening");
  if (!camStream) toggleCamera();
  respond("(The video call just connected. Greet me in one short, natural sentence.)");
}

function endCall() {
  inCall = false;
  interrupt();
  listener.stop();
  $("btn-call").textContent = "Start call";
  $("btn-call").className = "btn primary";
  $("btn-mic").disabled = true;
  setState("idle");
}

async function toggleCamera() {
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
    $("self-tile").classList.add("off");
    $("btn-cam").classList.add("off");
    return;
  }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 400 } });
    $("self-video").srcObject = camStream;
    $("self-tile").classList.remove("off");
    $("btn-cam").classList.remove("off");
  } catch (e) {
    showError(`Camera: ${e.message}`);
  }
}

// ---------- Setup ----------
async function loadAllModels() {
  const btn = $("btn-load-models");
  btn.disabled = true;
  try {
    const r = await fetch(`/api/models?provider=${encodeURIComponent($("sel-provider").value)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    $("model-list").innerHTML = data.models.map((m) => `<option value="${m}"></option>`).join("");
    addMessage("assistant", `Loaded ${data.models.length} models. Click the model box to pick one.`);
  } catch (e) {
    showError(`Could not list models: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function onProviderChange(keepModel) {
  const p = config.providers.find((x) => x.id === $("sel-provider").value);
  $("model-list").innerHTML = p.models.map((m) => `<option value="${m}"></option>`).join("");
  if (!keepModel || !$("inp-model").value) $("inp-model").value = p.models[0] || "";
}

function onPersonaChange() {
  const p = currentPersona();
  $("inp-prompt").value = p.prompt;
  $("bot-name").textContent = p.name.split(" (")[0];
  avatar?.setColor?.(p.cartoonColor);
}

async function init() {
  config = await (await fetch("/api/config")).json();

  fillSelect(
    $("sel-provider"),
    config.providers.map((p) => ({ value: p.id, label: p.name + (p.configured ? "" : " (no key)") })),
    settings.provider || config.providers.find((p) => p.configured)?.id,
  );
  onProviderChange(false);
  if (settings.model) $("inp-model").value = settings.model;

  fillSelect($("sel-persona"), config.personas.map((p) => ({ value: p.id, label: p.name })), settings.persona);
  onPersonaChange();
  if (settings.prompt) $("inp-prompt").value = settings.prompt;

  fillSelect(
    $("sel-tts"),
    [
      { value: "browser", label: "Browser voice (free)" },
      { value: "elevenlabs", label: "ElevenLabs", disabled: !config.tts.elevenlabs },
      { value: "openai", label: "OpenAI-compatible", disabled: !config.tts.openai },
    ],
    settings.tts,
  );
  fillSelect(
    $("sel-stt"),
    [
      { value: "browser", label: "Browser (Chrome / Edge)", disabled: !Listener.browserSupported() },
      { value: "server", label: "Server Whisper (STT_BASE_URL)", disabled: !config.stt.server },
    ],
    settings.stt,
  );
  if (![...$("sel-stt").options].some((o) => o.selected && !o.disabled)) {
    const ok = [...$("sel-stt").options].find((o) => !o.disabled);
    if (ok) $("sel-stt").value = ok.value;
  }

  $("inp-temp").value = settings.temperature ?? 0.8;
  $("temp-val").textContent = $("inp-temp").value;
  $("chk-vision").checked = Boolean(settings.vision);
  $("chk-bargein").checked = settings.bargeIn ?? true;
  $("inp-vrm").value = settings.vrmUrl || config.vrmUrl || "";
  $("inp-face").value = settings.faceId || config.simli.faceId || "";
  $("inp-voice").value = settings.voice || "";
  speaker.provider = $("sel-tts").value;
  speaker.voice = $("inp-voice").value;

  // Events
  $("sel-provider").onchange = () => (onProviderChange(false), saveSettings());
  $("inp-model").onchange = saveSettings;
  $("btn-load-models").onclick = loadAllModels;
  $("sel-persona").onchange = () => (onPersonaChange(), saveSettings());
  $("inp-prompt").onchange = saveSettings;
  $("inp-temp").oninput = () => (($("temp-val").textContent = $("inp-temp").value), saveSettings());
  $("chk-vision").onchange = saveSettings;
  $("chk-bargein").onchange = saveSettings;
  $("sel-tts").onchange = () => {
    speaker.stop();
    speaker.provider = $("sel-tts").value;
    if (avatarType === "simli" && speaker.provider === "browser") setAvatar("cartoon");
    saveSettings();
  };
  $("inp-voice").onchange = () => ((speaker.voice = $("inp-voice").value), saveSettings());
  $("sel-stt").onchange = async () => {
    saveSettings();
    if (inCall) await listener.start($("sel-stt").value).catch((e) => showError(e.message));
  };
  $("inp-vrm").onchange = () => (saveSettings(), avatarType === "vrm" && setAvatar("vrm"));
  $("inp-face").onchange = () => (saveSettings(), avatarType === "simli" && setAvatar("simli"));
  document.querySelectorAll("#seg-avatar button").forEach((b) => (b.onclick = () => setAvatar(b.dataset.v)));

  $("btn-call").onclick = () => (inCall ? endCall() : startCall());
  $("btn-mic").onclick = () => {
    micMuted = !micMuted;
    listener.setMuted(micMuted);
    $("btn-mic").textContent = micMuted ? "🔇 Muted" : "🎤 Mic on";
    $("btn-mic").classList.toggle("off", micMuted);
  };
  $("btn-cam").onclick = toggleCamera;
  $("btn-stop").onclick = interrupt;
  $("btn-panel").onclick = () => $("panel").classList.toggle("hidden");
  $("btn-clear").onclick = () => {
    history = [];
    store.set("history", history);
    renderHistory();
  };
  $("text-form").onsubmit = (e) => {
    e.preventDefault();
    speaker.unlock();
    const text = $("inp-text").value;
    $("inp-text").value = "";
    userSaid(text);
  };

  // Drop a .vrm file onto the video to use it as the 3D avatar.
  const stage = $("stage");
  stage.ondragover = (e) => (e.preventDefault(), stage.classList.add("drag"));
  stage.ondragleave = () => stage.classList.remove("drag");
  stage.ondrop = (e) => {
    e.preventDefault();
    stage.classList.remove("drag");
    const file = [...e.dataTransfer.files].find((f) => /\.(vrm|glb)$/i.test(f.name));
    if (file) setAvatar("vrm", { url: URL.createObjectURL(file) });
  };

  $("self-tile").classList.add("off");
  $("btn-cam").classList.add("off");
  renderHistory();
  await setAvatar(settings.avatar || "cartoon");
  animate();
}

init().catch((e) => showError(`Startup failed: ${e.message}`));
