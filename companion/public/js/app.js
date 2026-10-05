// Orchestrates the call: mic/text -> LLM (streamed) -> sentence queue -> TTS -> avatar,
// plus characters, user profiles, recognition and long-term memory.
import { Speaker, Listener } from "./speech.js";
import { CartoonAvatar } from "./avatars/cartoon.js";
import { compilePrompt, TRAITS } from "./character.js";
import { FaceId, VoicePrint } from "./recognition.js";

const $ = (id) => document.getElementById(id);
const local = {
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

const LEARN_EVERY = 5; // user messages between automatic memory updates
const GUEST = "guest";

let config;
let settings = local.get("settings", {});
let characters = [];
let character = null;
let profiles = [];
let profileId = local.get("profile", GUEST);
let recognizedBy = ""; // "face" | "voice" | "" (picked manually)
let memory = { facts: [], summary: "", history: [], lastSeen: 0, calls: 0 };
let history = [];
let learnedUpTo = 0; // history index already sent to the memory learner
let learning = null;
let avatar = null;
let avatarKey = "";
let state = "idle";
let inCall = false;
let micOn = false;
let camStream = null;
let reply = null; // { controller, splitter, bubble } for the in-flight answer
let pendingFace = null; // face seen while still a guest, saved once we learn their name
let droppedVrm = ""; // object URL of a .vrm file dropped onto the stage (this session only)

const faceId = new FaceId();
const voicePrint = new VoicePrint();

// ---------- small helpers ----------
async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${method} ${path} failed (${r.status})`);
  return data;
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function toast(msg, isError = false) {
  if (isError) console.error(msg);
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast${isError ? " error" : ""}`;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), isError ? 7000 : 4000);
}

function showError(msg) {
  toast(msg, true);
  addMessage("error", msg);
}

function setState(s) {
  state = s;
  $("state-dot").className = `dot ${s}`;
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
  for (const m of history) addMessage(m.role, m.content);
}

function fillSelect(sel, items, value) {
  sel.innerHTML = "";
  for (const { value: v, label, disabled } of items) {
    const o = new Option(label, v);
    o.disabled = Boolean(disabled);
    sel.add(o);
  }
  if (value !== undefined && [...sel.options].some((o) => o.value === value && !o.disabled)) sel.value = value;
}

function saveSettings() {
  settings = {
    provider: $("sel-provider").value,
    model: $("inp-model").value,
    temperature: Number($("inp-temp").value),
    vision: $("chk-vision").checked,
    tts: $("sel-tts").value,
    stt: $("sel-stt").value,
    bargeIn: $("chk-bargein").checked,
    learn: $("chk-learn").checked,
    joinMic: $("chk-join-mic").checked,
    joinCam: $("chk-join-cam").checked,
    face: $("chk-face").checked,
    voice: $("chk-voice").checked,
    character: character?.id,
  };
  local.set("settings", settings);
}

function llmChoice() {
  return { provider: $("sel-provider").value, model: $("inp-model").value.trim() };
}

function currentProfile() {
  return profiles.find((p) => p.id === profileId) || null;
}

function who() {
  const p = currentProfile();
  return { name: p?.name, recognizedBy, ...memory };
}

// ---------- voice ----------
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

function effectiveTts() {
  const want = character?.voice?.tts || $("sel-tts").value || "browser";
  const ok = [...$("sel-tts").options].some((o) => o.value === want && !o.disabled);
  return ok ? want : "browser";
}

function applyVoice() {
  const tts = effectiveTts();
  if (speaker.provider !== tts) speaker.stop();
  speaker.provider = tts;
  speaker.voice = character?.voice?.voice || "";
}

// ---------- avatar ----------
async function applyAvatar() {
  const look = character.look;
  let type = look.avatar;
  if (type === "simli" && effectiveTts() === "browser") {
    toast("Photoreal needs a server voice (ElevenLabs or OpenAI-compatible). Showing the cartoon instead.", true);
    type = "cartoon";
  }
  document.querySelectorAll("#seg-avatar button").forEach((b) => b.classList.toggle("on", b.dataset.v === look.avatar));
  document.querySelectorAll("[data-for]").forEach((el) => (el.hidden = el.dataset.for !== look.avatar));

  const vrmUrl = droppedVrm || look.vrmUrl || config.vrmUrl;
  const key = type === "vrm" ? `vrm:${vrmUrl}` : type === "simli" ? `simli:${look.simliFaceId}` : "cartoon";
  if (key === avatarKey && avatar) {
    avatar.setLook?.(look);
    return;
  }
  speaker.stop();
  avatar?.destroy();
  avatar = null;
  avatarKey = key;
  const root = $("avatar-root");
  root.innerHTML = "";
  try {
    let next;
    if (type === "vrm") {
      const { VrmAvatar } = await import("./avatars/vrm.js");
      next = new VrmAvatar({ url: vrmUrl });
    } else if (type === "simli") {
      const { SimliAvatar } = await import("./avatars/simli.js");
      next = new SimliAvatar({ faceId: look.simliFaceId || config.simli.faceId });
    } else {
      next = new CartoonAvatar({ look });
    }
    await next.mount(root);
    if (avatarKey !== key) return next.destroy(); // switched again while loading
    avatar = next;
  } catch (e) {
    showError(`Could not load the ${type} avatar: ${e.message || e}`);
    avatarKey = "cartoon";
    avatar = new CartoonAvatar({ look });
    await avatar.mount(root);
  }
}

function animate() {
  avatar?.update?.(speaker.level(), state);
  requestAnimationFrame(animate);
}

// ---------- characters ----------
function getField(obj, path) {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}

function setField(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ??= {}), obj)[last] = value;
}

function renderCharacterForm() {
  for (const el of document.querySelectorAll("#char-form [data-f]")) {
    const v = getField(character, el.dataset.f);
    if (el.type === "checkbox") el.checked = Boolean(v);
    else el.value = v ?? "";
  }
  for (const t of TRAITS) {
    $(`trait-${t}`).value = character.traits[t];
    $(`trait-${t}-v`).textContent = character.traits[t];
  }
  renderPromptPreview();
}

function renderPromptPreview() {
  $("prompt-preview").textContent = compilePrompt(character, who());
}

function renderCharacterList() {
  fillSelect(
    $("sel-character"),
    characters.map((c) => ({ value: c.id, label: c.tagline ? `${c.name} — ${c.tagline}` : c.name })),
    character?.id,
  );
}

const saveCharacter = debounce(async () => {
  try {
    const saved = await api("/api/characters", { method: "POST", body: character });
    const i = characters.findIndex((c) => c.id === saved.id);
    if (i >= 0) characters[i] = saved;
    $("save-status").textContent = "Saved.";
    renderCharacterList();
  } catch (e) {
    showError(`Could not save character: ${e.message}`);
  }
}, 600);

function onCharacterEdited() {
  $("bot-name").textContent = character.name;
  $("save-status").textContent = "Saving…";
  renderPromptPreview();
  applyVoice();
  applyAvatar();
  saveCharacter();
}

async function selectCharacter(id) {
  if (character && character.id !== id) {
    learnNow();
    interrupt();
  }
  character = characters.find((c) => c.id === id) || characters[0];
  droppedVrm = "";
  saveSettings();
  renderCharacterList();
  renderCharacterForm();
  $("bot-name").textContent = character.name;
  $("memory-title").textContent = `What ${character.name} remembers about you`;
  applyVoice();
  await Promise.all([applyAvatar(), loadMemory()]);
}

async function upsertAndSelect(c) {
  const saved = await api("/api/characters", { method: "POST", body: c });
  characters = characters.filter((x) => x.id !== saved.id).concat(saved);
  await selectCharacter(saved.id);
  return saved;
}

async function generateCharacter() {
  const description = $("inp-describe").value.trim();
  if (!description) return toast("Describe the character you want first.", true);
  const btn = $("btn-generate");
  btn.disabled = true;
  btn.textContent = "Creating…";
  try {
    const c = await api("/api/characters/generate", { method: "POST", body: { description, ...llmChoice() } });
    const saved = await upsertAndSelect(c);
    $("inp-describe").value = "";
    toast(`Meet ${saved.name}! Tweak anything below.`);
  } catch (e) {
    showError(`Character creation failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Create character";
  }
}

async function tweakCharacter() {
  const instruction = $("inp-tweak").value.trim();
  if (!instruction) return;
  const btn = $("btn-tweak");
  btn.disabled = true;
  btn.textContent = "Applying…";
  try {
    const c = await api("/api/characters/generate", { method: "POST", body: { base: character, instruction, ...llmChoice() } });
    await upsertAndSelect(c);
    $("inp-tweak").value = "";
    toast(`${c.name} updated.`);
  } catch (e) {
    showError(`Tweak failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Apply change";
  }
}

// ---------- profiles & memory ----------
function renderProfiles() {
  fillSelect(
    $("sel-profile"),
    [{ value: GUEST, label: "Guest (not recognized yet)" }, ...profiles.map((p) => ({ value: p.id, label: p.name }))],
    profileId,
  );
  const p = currentProfile();
  const badge = $("who-badge");
  badge.hidden = !p;
  if (p) badge.textContent = `With ${p.name}${recognizedBy ? ` · recognized by ${recognizedBy}` : ""}`;
  const bio = p ? `${p.faces.length} face print(s), ${p.voices.length} voice print(s) saved.` : "Not signed in as anyone.";
  $("recog-status").textContent = (recognizedBy && p ? `Recognized ${p.name} by ${recognizedBy}. ` : "") + bio;
}

async function loadProfiles() {
  profiles = await api("/api/profiles");
  if (profileId !== GUEST && !currentProfile()) profileId = GUEST;
  renderProfiles();
}

async function setProfile(id, by = "", { keepHistory = false } = {}) {
  if (id === profileId) {
    if (by && by !== recognizedBy) {
      recognizedBy = by;
      renderProfiles();
      renderPromptPreview();
    }
    return;
  }
  if (!keepHistory) learnNow();
  profileId = id;
  recognizedBy = by;
  local.set("profile", id);
  renderProfiles();
  await loadMemory({ keepHistory });
  const p = currentProfile();
  if (p && by) toast(`Recognized ${p.name} by ${by}.`);
}

async function loadMemory({ keepHistory = false } = {}) {
  if (!character) return;
  memory = await api(`/api/memory?profile=${profileId}&character=${character.id}`);
  if (!keepHistory) {
    history = memory.history || [];
    learnedUpTo = history.length;
    renderHistory();
  }
  renderMemory();
}

function renderMemory() {
  const ul = $("facts");
  ul.innerHTML = "";
  if (!memory.facts.length) {
    ul.innerHTML = `<li class="empty">Nothing yet. They'll pick things up as you talk.</li>`;
  }
  memory.facts.forEach((f, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span></span><button title="Forget this">✕</button>`;
    li.firstChild.textContent = f;
    li.lastChild.onclick = () => saveFacts(memory.facts.filter((_, j) => j !== i));
    ul.appendChild(li);
  });
  $("inp-summary").value = memory.summary || "";
  renderPromptPreview();
}

async function saveFacts(facts) {
  memory = await api("/api/memory", { method: "PUT", body: { profile: profileId, character: character.id, facts } });
  renderMemory();
}

const saveHistory = debounce(() => {
  api("/api/memory", { method: "PUT", body: { profile: profileId, character: character.id, history } }).catch((e) =>
    console.warn("history save failed", e),
  );
}, 800);

/** Sends the turns since the last update to the server, which extracts facts about the user. */
function learnNow({ quiet = true } = {}) {
  const turns = history.slice(learnedUpTo);
  if (!character || !turns.some((m) => m.role === "user")) {
    if (!quiet) toast("Nothing new to learn yet.");
    return learning;
  }
  const upTo = history.length;
  const forProfile = profileId;
  const forCharacter = character.id;
  learning = (async () => {
    try {
      const out = await api("/api/memory/learn", {
        method: "POST",
        body: { profile: forProfile, character: forCharacter, turns, ...llmChoice() },
      });
      if (forCharacter !== character?.id) return;
      learnedUpTo = Math.max(learnedUpTo, upTo);
      if (out.createdProfile && forProfile === profileId) {
        // A guest told us their name: they now have a profile; attach their face / voice if we have them.
        const p = out.createdProfile;
        if (pendingFace && $("chk-face").checked) await api(`/api/profiles/${p.id}`, { method: "PUT", body: { addFace: pendingFace } });
        const vp = $("chk-voice").checked && voicePrint.print();
        if (vp) await api(`/api/profiles/${p.id}`, { method: "PUT", body: { addVoice: vp } });
        pendingFace = null;
        await loadProfiles();
        await setProfile(p.id, "", { keepHistory: true });
        saveHistory();
        toast(`${character.name} will remember you, ${p.name}.`);
      } else if (forProfile === profileId) {
        memory = out.memory;
        renderMemory();
      }
      if (out.learned?.length && !quiet) toast(`Learned: ${out.learned.join("; ")}`);
    } catch (e) {
      if (!quiet) showError(`Learning failed: ${e.message}`);
      else console.warn("learning failed", e);
    } finally {
      learning = null;
    }
  })();
  return learning;
}

// ---------- recognition ----------
async function recognizeFace({ announce = false } = {}) {
  if (!$("chk-face").checked || !camStream) return null;
  try {
    const d = await faceId.capture($("self-video"));
    if (!d) return null;
    const hit = faceId.match(d, profiles);
    if (hit) await setProfile(hit.profile.id, "face");
    else {
      pendingFace = d;
      if (announce) toast("I don't recognize this face yet.");
    }
    return hit;
  } catch (e) {
    console.warn("face recognition unavailable", e);
    return null;
  }
}

let voiceTimer;
async function startVoiceRecognition() {
  if (!$("chk-voice").checked || !micOn) return;
  try {
    voicePrint.reset();
    await voicePrint.start(() => !speaker.speaking);
  } catch (e) {
    return console.warn("voice print unavailable", e);
  }
  clearInterval(voiceTimer);
  voiceTimer = setInterval(() => {
    const print = voicePrint.print(4);
    if (!print) return;
    const hit = voicePrint.match(print, profiles);
    if (hit && hit.profile.id !== profileId && profileId === GUEST) setProfile(hit.profile.id, "voice");
    if (voicePrint.seconds > 20) voicePrint.reset(); // keep it about the current speaker
  }, 1500);
}

function stopVoiceRecognition() {
  clearInterval(voiceTimer);
  voicePrint.stop();
}

async function ensureNamedProfile() {
  if (currentProfile()) return currentProfile();
  const name = prompt("What's your name?");
  if (!name?.trim()) return null;
  const p = await api("/api/profiles", { method: "POST", body: { name } });
  await loadProfiles();
  await setProfile(p.id);
  return p;
}

async function enrollFace() {
  const p = await ensureNamedProfile();
  if (!p) return;
  if (!camStream) await setCamera(true);
  toast("Look at the camera…");
  try {
    let n = 0;
    for (let i = 0; i < 3; i++) {
      const d = await faceId.capture($("self-video"));
      if (d) {
        await api(`/api/profiles/${p.id}`, { method: "PUT", body: { addFace: d } });
        n++;
      }
    }
    await loadProfiles();
    toast(n ? `Got it! ${character.name} will recognize your face, ${p.name}.` : "Couldn't see a face. Try better lighting.", !n);
    if (n) {
      $("chk-face").checked = true;
      saveSettings();
    }
  } catch (e) {
    showError(`Face recognition failed to load: ${e.message}`);
  }
}

async function enrollVoice() {
  const p = await ensureNamedProfile();
  if (!p) return;
  const vp = new VoicePrint();
  try {
    await vp.start();
  } catch (e) {
    return showError(`Microphone: ${e.message}`);
  }
  toast("Keep talking for about 8 seconds, e.g. tell them about your day…");
  const started = Date.now();
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (vp.seconds >= 6 || Date.now() - started > 20000) {
        clearInterval(t);
        resolve();
      }
    }, 300);
  });
  const print = vp.print(3);
  vp.stop();
  if (!print) return toast("Didn't hear enough speech. Try again a bit louder.", true);
  await api(`/api/profiles/${p.id}`, { method: "PUT", body: { addVoice: print } });
  await loadProfiles();
  $("chk-voice").checked = true;
  saveSettings();
  toast(`Voice saved for ${p.name}. (Experimental: works best in a quiet room.)`);
}

// ---------- conversation ----------
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
  speaker.unlock();
  if (reply || speaker.speaking) interrupt();
  history.push({ role: "user", content: text });
  addMessage("user", text);
  respond();
}

function buildMessages(extraUser) {
  const msgs = [{ role: "system", content: compilePrompt(character, who()) }];
  const recent = history.slice(-40);
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
    this.spoken = 0;
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
    if (!cut && rest.length > 180) cut = rest.lastIndexOf(", ", 180) + 1;
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
  const current = { controller, bubble, splitter };
  reply = current;
  setState("thinking");
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...llmChoice(), temperature: Number($("inp-temp").value), messages: buildMessages(extraUser) }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Chat failed (${r.status})`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text = splitter.push(dec.decode(value, { stream: true }));
      bubble.textContent = text || "…";
      $("caption").textContent = text.slice(-160);
    }
    text = splitter.flush();
    bubble.textContent = text || "(no reply)";
    if (text) history.push({ role: "assistant", content: text });
  } catch (e) {
    if (e.name !== "AbortError") {
      bubble.remove();
      showError(e.message);
    }
  } finally {
    saveHistory();
    if (reply === current) {
      reply = null;
      if (!speaker.speaking) setState(inCall ? "listening" : "idle");
      const userTurns = history.slice(learnedUpTo).filter((m) => m.role === "user").length;
      if ($("chk-learn").checked && userTurns >= LEARN_EVERY && !learning) learnNow();
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

// ---------- call controls ----------
async function setMic(on) {
  if (on) {
    speaker.unlock();
    try {
      await listener.start($("sel-stt").value);
    } catch (e) {
      return showError(`Microphone: ${e.message}`);
    }
    micOn = true;
    startVoiceRecognition();
  } else {
    listener.stop();
    stopVoiceRecognition();
    micOn = false;
  }
  $("btn-mic").textContent = micOn ? "🎤 Mic on" : "🎤 Mic off";
  $("btn-mic").classList.toggle("off", !micOn);
  if (inCall) setState(speaker.speaking ? "speaking" : reply ? "thinking" : "listening");
}

async function setCamera(on) {
  if (!on) {
    camStream?.getTracks().forEach((t) => t.stop());
    camStream = null;
  } else if (!camStream) {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 400 } });
      $("self-video").srcObject = camStream;
      await $("self-video").play().catch(() => {});
    } catch (e) {
      showError(`Camera: ${e.message}`);
    }
  }
  $("self-tile").classList.toggle("off", !camStream);
  $("btn-cam").textContent = camStream ? "📷 Camera on" : "📷 Camera off";
  $("btn-cam").classList.toggle("off", !camStream);
  if (camStream && inCall && profileId === GUEST) recognizeFace({ announce: true });
}

async function startCall() {
  speaker.unlock();
  inCall = true;
  $("btn-call").textContent = "End call";
  $("btn-call").className = "btn danger";
  setState("listening");
  await Promise.all([
    $("chk-join-mic").checked ? setMic(true) : null,
    $("chk-join-cam").checked ? setCamera(true) : null,
  ]);
  // Give face recognition a moment so the greeting can use their name.
  if (camStream && profileId === GUEST) {
    setState("thinking");
    await Promise.race([recognizeFace(), new Promise((r) => setTimeout(r, 4000))]);
  }
  api("/api/memory", { method: "PUT", body: { profile: profileId, character: character.id, callStarted: true } })
    .then((m) => (memory = m))
    .catch(() => {});
  const p = currentProfile();
  const since = memory.lastSeen ? " It's been a while since your last call, so reflect that naturally." : "";
  respond(
    `(The video call just connected.${p ? ` It's ${p.name}.` : ""}${since} Greet them in one or two short spoken sentences.` +
      `${character.greeting ? ` Your usual greeting is: "${character.greeting}". Adapt it.` : ""})`,
  );
}

async function endCall() {
  inCall = false;
  interrupt();
  await setMic(false);
  $("btn-call").textContent = "Start call";
  $("btn-call").className = "btn primary";
  setState("idle");
  if ($("chk-learn").checked) learnNow({ quiet: false });
}

// ---------- settings ----------
async function loadAllModels() {
  const btn = $("btn-load-models");
  btn.disabled = true;
  try {
    const data = await api(`/api/models?provider=${encodeURIComponent($("sel-provider").value)}`);
    $("model-list").innerHTML = data.models.map((m) => `<option value="${m}"></option>`).join("");
    toast(`Loaded ${data.models.length} models. Click the model box to pick one.`);
  } catch (e) {
    showError(`Could not list models: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function onProviderChange() {
  const p = config.providers.find((x) => x.id === $("sel-provider").value);
  $("model-list").innerHTML = p.models.map((m) => `<option value="${m}"></option>`).join("");
  $("inp-model").value = p.models[0] || "";
}

// ---------- init ----------
function buildTraitSliders() {
  $("trait-sliders").innerHTML = TRAITS.map(
    (t) => `<label class="slider">${t[0].toUpperCase() + t.slice(1)}
      <input type="range" id="trait-${t}" min="0" max="10" step="1" /><span id="trait-${t}-v"></span></label>`,
  ).join("");
  for (const t of TRAITS) {
    $(`trait-${t}`).oninput = (e) => {
      character.traits[t] = Number(e.target.value);
      $(`trait-${t}-v`).textContent = e.target.value;
      onCharacterEdited();
    };
  }
}

function wireEvents() {
  // tabs
  document.querySelectorAll(".tabs button").forEach(
    (b) =>
      (b.onclick = () => {
        document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
        document.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
      }),
  );

  // character editor
  for (const el of document.querySelectorAll("#char-form [data-f]")) {
    el.addEventListener(el.type === "color" || el.tagName === "SELECT" || el.type === "checkbox" ? "input" : "change", () => {
      setField(character, el.dataset.f, el.type === "checkbox" ? el.checked : el.value);
      onCharacterEdited();
    });
  }
  document.querySelectorAll("#seg-avatar button").forEach(
    (b) =>
      (b.onclick = () => {
        character.look.avatar = b.dataset.v;
        onCharacterEdited();
      }),
  );
  $("sel-character").onchange = () => selectCharacter($("sel-character").value);
  $("btn-generate").onclick = generateCharacter;
  $("btn-tweak").onclick = tweakCharacter;
  $("inp-tweak").onkeydown = (e) => e.key === "Enter" && tweakCharacter();
  $("btn-dup").onclick = () => upsertAndSelect({ ...structuredClone(character), id: undefined, name: `${character.name} copy` });
  $("btn-del-char").onclick = async () => {
    if (!confirm(`Delete ${character.name} and their memories of everyone?`)) return;
    try {
      await api(`/api/characters/${character.id}`, { method: "DELETE" });
      characters = characters.filter((c) => c.id !== character.id);
      character = null;
      await selectCharacter(characters[0].id);
    } catch (e) {
      showError(e.message);
    }
  };

  // profiles & memory
  $("sel-profile").onchange = () => setProfile($("sel-profile").value);
  $("btn-new-profile").onclick = async () => {
    const name = prompt("Name for the new person:");
    if (!name?.trim()) return;
    const p = await api("/api/profiles", { method: "POST", body: { name } });
    await loadProfiles();
    await setProfile(p.id);
  };
  $("btn-rename-profile").onclick = async () => {
    const p = currentProfile();
    if (!p) return toast("Pick or create a person first.");
    const name = prompt("New name:", p.name);
    if (!name?.trim()) return;
    await api(`/api/profiles/${p.id}`, { method: "PUT", body: { name } });
    await loadProfiles();
    renderPromptPreview();
  };
  $("btn-del-profile").onclick = async () => {
    const p = currentProfile();
    if (!p || !confirm(`Delete ${p.name} and everything every character remembers about them?`)) return;
    await api(`/api/profiles/${p.id}`, { method: "DELETE" });
    await setProfile(GUEST, "", { keepHistory: true });
    await loadProfiles();
    await loadMemory();
  };
  $("btn-enroll-face").onclick = enrollFace;
  $("btn-enroll-voice").onclick = enrollVoice;
  $("btn-clear-bio").onclick = async () => {
    const p = currentProfile();
    if (!p) return;
    await api(`/api/profiles/${p.id}`, { method: "PUT", body: { clearFaces: true, clearVoices: true } });
    await loadProfiles();
    toast("Face and voice prints deleted.");
  };
  $("fact-form").onsubmit = (e) => {
    e.preventDefault();
    const f = $("inp-fact").value.trim();
    $("inp-fact").value = "";
    if (f) saveFacts([...memory.facts, f]);
  };
  $("inp-summary").onchange = async () => {
    memory = await api("/api/memory", {
      method: "PUT",
      body: { profile: profileId, character: character.id, summary: $("inp-summary").value },
    });
    renderPromptPreview();
  };
  $("btn-learn").onclick = () => learnNow({ quiet: false });
  $("btn-forget-rel").onclick = async () => {
    if (!confirm(`Make ${character.name} forget your conversations and relationship?`)) return;
    memory = await api(`/api/memory?profile=${profileId}&character=${character.id}`, { method: "DELETE" });
    history = [];
    learnedUpTo = 0;
    renderHistory();
    renderMemory();
  };
  $("btn-forget-all").onclick = async () => {
    if (!confirm("Forget every fact about you, plus this relationship?")) return;
    memory = await api(`/api/memory?profile=${profileId}&character=${character.id}&scope=all`, { method: "DELETE" });
    history = [];
    learnedUpTo = 0;
    renderHistory();
    renderMemory();
  };

  // settings
  $("sel-provider").onchange = () => (onProviderChange(), saveSettings());
  $("inp-model").onchange = saveSettings;
  $("btn-load-models").onclick = loadAllModels;
  $("inp-temp").oninput = () => (($("temp-val").textContent = $("inp-temp").value), saveSettings());
  for (const id of ["chk-vision", "chk-bargein", "chk-learn", "chk-join-mic", "chk-join-cam"]) $(id).onchange = saveSettings;
  $("chk-face").onchange = () => (saveSettings(), $("chk-face").checked && inCall && recognizeFace({ announce: true }));
  $("chk-voice").onchange = () => (saveSettings(), $("chk-voice").checked ? startVoiceRecognition() : stopVoiceRecognition());
  $("sel-tts").onchange = () => (saveSettings(), applyVoice(), applyAvatar());
  $("sel-stt").onchange = async () => {
    saveSettings();
    if (micOn) await setMic(true);
  };

  // call controls
  $("btn-call").onclick = () => (inCall ? endCall() : startCall());
  $("btn-mic").onclick = () => (!micOn && !inCall ? startCall().then(() => !micOn && setMic(true)) : setMic(!micOn));
  $("btn-cam").onclick = () => setCamera(!camStream);
  $("btn-stop").onclick = interrupt;
  $("btn-panel").onclick = () => $("panel").classList.toggle("hidden");
  $("text-form").onsubmit = (e) => {
    e.preventDefault();
    const text = $("inp-text").value;
    $("inp-text").value = "";
    userSaid(text);
  };

  // Drop a .vrm file onto the video to use it as this character's 3D avatar (for this session).
  const stage = $("stage");
  stage.ondragover = (e) => (e.preventDefault(), stage.classList.add("drag"));
  stage.ondragleave = () => stage.classList.remove("drag");
  stage.ondrop = (e) => {
    e.preventDefault();
    stage.classList.remove("drag");
    const file = [...e.dataTransfer.files].find((f) => /\.(vrm|glb)$/i.test(f.name));
    if (!file) return;
    droppedVrm = URL.createObjectURL(file);
    character.look.avatar = "vrm";
    onCharacterEdited();
    toast("Using the dropped model for now. Host it online and paste the URL in Character → Look to keep it.");
  };

  addEventListener("beforeunload", () => learnNow());
}

async function init() {
  [config, characters] = await Promise.all([api("/api/config"), api("/api/characters")]);

  fillSelect(
    $("sel-provider"),
    config.providers.map((p) => ({ value: p.id, label: p.name + (p.configured ? "" : " (no key)") })),
    settings.provider || config.providers.find((p) => p.configured)?.id,
  );
  onProviderChange();
  if (settings.model) $("inp-model").value = settings.model;
  $("inp-temp").value = settings.temperature ?? 0.8;
  $("temp-val").textContent = $("inp-temp").value;

  const ttsOptions = [
    { value: "browser", label: "Browser voice (free)" },
    { value: "elevenlabs", label: "ElevenLabs", disabled: !config.tts.elevenlabs },
    { value: "openai", label: "OpenAI-compatible", disabled: !config.tts.openai },
  ];
  fillSelect($("sel-tts"), ttsOptions, settings.tts);
  fillSelect($("sel-char-tts"), [{ value: "", label: "App default (Settings)" }, ...ttsOptions]);
  fillSelect(
    $("sel-stt"),
    [
      { value: "browser", label: "Browser (Chrome / Edge)", disabled: !Listener.browserSupported() },
      { value: "server", label: "Server Whisper (STT_BASE_URL)", disabled: !config.stt.server },
    ],
    settings.stt,
  );
  if ($("sel-stt").selectedOptions[0]?.disabled) {
    const ok = [...$("sel-stt").options].find((o) => !o.disabled);
    if (ok) $("sel-stt").value = ok.value;
  }
  $("chk-vision").checked = Boolean(settings.vision);
  $("chk-bargein").checked = settings.bargeIn ?? true;
  $("chk-learn").checked = settings.learn ?? true;
  $("chk-join-mic").checked = settings.joinMic ?? true;
  $("chk-join-cam").checked = Boolean(settings.joinCam);
  $("chk-face").checked = Boolean(settings.face);
  $("chk-voice").checked = Boolean(settings.voice);

  buildTraitSliders();
  wireEvents();
  await loadProfiles();
  await selectCharacter(settings.character || characters[0]?.id);
  animate();
}

init().catch((e) => showError(`Startup failed: ${e.message}`));
