// The Memories page: view, search, add, edit, star (core) and delete what a character remembers.
const $ = (id) => document.getElementById(id);
const GUEST = "guest";
const params = new URLSearchParams(location.search);

let profiles = [];
let characters = [];
let profile = params.get("profile") || readLocal("profile") || GUEST;
let character = params.get("character") || readLocal("settings")?.character;
let memory = { facts: [], moments: [], summary: "" };
let filter = "all";

function readLocal(k) {
  try {
    return JSON.parse(localStorage.getItem(`companion.${k}`));
  } catch {
    return null;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) location.href = "/login.html";
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast mem-toast${isError ? " error" : ""}`;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2500);
}

const q = () => `profile=${encodeURIComponent(profile)}&character=${encodeURIComponent(character)}`;
const personName = () => profiles.find((p) => p.id === profile)?.name || "this person";
const charName = () => characters.find((c) => c.id === character)?.name || "They";

function when(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

// ---------- rendering ----------
function itemRow(m) {
  const li = document.createElement("li");
  li.className = `mem-item${m.core ? " core" : ""}`;
  li.innerHTML = `
    <button class="star" title="${m.core ? "Unmark as core memory" : "Make this a core memory"}" aria-label="Core memory">${m.core ? "★" : "☆"}</button>
    <div class="mem-main">
      <div class="mem-text" contenteditable="plaintext-only" spellcheck="true"></div>
      <div class="mem-meta">
        <span></span>
        <select aria-label="Type">
          <option value="about">About them</option>
          <option value="moment">Moment</option>
        </select>
      </div>
    </div>
    <button class="del" title="Delete" aria-label="Delete">🗑</button>`;
  const text = li.querySelector(".mem-text");
  text.textContent = m.text;
  li.querySelector(".mem-meta span").textContent = `${m.source === "you" ? "Added or edited by you" : "Learned"} · ${when(m.updatedAt)}`;
  const kind = li.querySelector("select");
  kind.value = m.kind;

  li.querySelector(".star").onclick = () => update(m.id, { core: !m.core }, m.core ? "No longer a core memory" : "⭐ Core memory");
  kind.onchange = () => update(m.id, { kind: kind.value }, "Moved");
  li.querySelector(".del").onclick = async () => {
    if (!confirm(`Delete this memory?\n\n“${m.text}”`)) return;
    memory = await api(`/api/memory/items/${m.id}?${q()}`, { method: "DELETE" });
    render();
    toast("Deleted");
  };
  // Edit in place: Enter or leaving the field saves, Esc cancels.
  text.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      text.blur();
    } else if (e.key === "Escape") {
      text.textContent = m.text;
      text.blur();
    }
  };
  text.onblur = () => {
    const v = text.textContent.trim();
    if (!v) text.textContent = m.text;
    else if (v !== m.text) update(m.id, { text: v }, "Saved");
  };
  return li;
}

function render() {
  const term = $("search").value.trim().toLowerCase();
  const all = [...memory.facts, ...memory.moments].filter((m) => !term || m.text.toLowerCase().includes(term));
  const groups = {
    core: all.filter((m) => m.core),
    about: all.filter((m) => !m.core && m.kind === "about"),
    moment: all.filter((m) => !m.core && m.kind === "moment"),
  };
  for (const [key, items] of Object.entries(groups)) {
    const ul = $(`list-${key}`);
    ul.innerHTML = "";
    // newest first
    [...items].sort((a, b) => b.updatedAt - a.updatedAt).forEach((m) => ul.appendChild(itemRow(m)));
    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "mem-empty";
      empty.textContent = term
        ? "No matches."
        : key === "core"
          ? "No core memories yet. Tap ☆ on any memory to make it core."
          : "Nothing yet. They'll pick things up as you talk.";
      ul.appendChild(empty);
    }
    document.querySelector(`[data-sec="${key}"]`).hidden = filter !== "all" && filter !== key;
  }
  $("about-title").textContent = `About ${personName()}`;
  $("mem-intro").textContent =
    `What ${charName()} remembers about ${personName()}. Facts “about them” are shared by all characters; moments belong to this relationship.`;
  if (document.activeElement !== $("summary")) $("summary").value = memory.summary || "";
}

async function update(id, changes, msg) {
  try {
    memory = await api(`/api/memory/items/${id}`, { method: "PATCH", body: { profile, character, ...changes } });
    render();
    if (msg) toast(msg);
  } catch (e) {
    toast(e.message, true);
  }
}

async function load() {
  memory = await api(`/api/memory?${q()}`);
  const url = new URL(location.href);
  url.searchParams.set("profile", profile);
  url.searchParams.set("character", character);
  history.replaceState(null, "", url);
  render();
}

// ---------- setup ----------
async function init() {
  [profiles, characters] = await Promise.all([api("/api/profiles"), api("/api/characters")]);
  if (!characters.some((c) => c.id === character)) character = characters[0]?.id;
  if (profile !== GUEST && !profiles.some((p) => p.id === profile)) profile = GUEST;

  const fill = (sel, items, value) => {
    sel.innerHTML = "";
    items.forEach(([v, label]) => sel.add(new Option(label, v)));
    sel.value = value;
  };
  fill($("sel-profile"), [[GUEST, "Guest"], ...profiles.map((p) => [p.id, p.name])], profile);
  fill($("sel-character"), characters.map((c) => [c.id, c.name]), character);
  $("sel-profile").onchange = () => ((profile = $("sel-profile").value), load());
  $("sel-character").onchange = () => ((character = $("sel-character").value), load());

  $("add-form").onsubmit = async (e) => {
    e.preventDefault();
    const text = $("add-text").value.trim();
    if (!text) return;
    try {
      memory = await api("/api/memory/items", {
        method: "POST",
        body: { profile, character, text, kind: $("add-kind").value, core: $("add-core").checked },
      });
      $("add-text").value = "";
      $("add-core").checked = false;
      render();
      toast("Added");
    } catch (err) {
      toast(err.message, true);
    }
  };
  $("add-text").onkeydown = (e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), $("add-form").requestSubmit());

  $("search").oninput = render;
  document.querySelectorAll("#filter button").forEach(
    (b) =>
      (b.onclick = () => {
        filter = b.dataset.f;
        document.querySelectorAll("#filter button").forEach((x) => x.classList.toggle("on", x === b));
        render();
      }),
  );

  $("summary").onchange = async () => {
    memory = await api("/api/memory", { method: "PUT", body: { profile, character, summary: $("summary").value } });
    $("summary-status").textContent = "Saved.";
    setTimeout(() => ($("summary-status").textContent = ""), 2000);
  };
  $("btn-forget-rel").onclick = async () => {
    if (!confirm(`Make ${charName()} forget your moments, chat history and relationship? Facts about you stay.`)) return;
    memory = await api(`/api/memory?${q()}`, { method: "DELETE" });
    render();
  };
  $("btn-forget-all").onclick = async () => {
    if (!confirm(`Forget EVERYTHING about ${personName()}, including core memories? This can't be undone.`)) return;
    memory = await api(`/api/memory?${q()}&scope=all`, { method: "DELETE" });
    render();
  };
  await load();
}

init().catch((e) => toast(`Couldn't load memories: ${e.message}`, true));
