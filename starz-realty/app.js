// Renders the site from content.json. A draft saved in the editor (admin.html)
// overrides it in this browser only, so edits can be previewed before publishing.
const DRAFT_KEY = "starz-draft";

const get = (obj, path) => path.split(".").reduce((o, k) => (o ? o[k] : ""), obj);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const digits = (s) => String(s || "").replace(/[^\d+]/g, "");

async function loadContent() {
  try {
    const draft = localStorage.getItem(DRAFT_KEY);
    if (draft) return JSON.parse(draft);
  } catch {}
  const res = await fetch("content.json", { cache: "no-cache" });
  return res.json();
}

function render(c) {
  document.documentElement.style.setProperty("--accent", c.brand.accent);
  document.documentElement.style.setProperty("--dark", c.brand.dark);
  document.title = `${c.brand.name} | ${c.brand.tagline}`;

  document.querySelectorAll("[data-bind]").forEach((el) => (el.textContent = get(c, el.dataset.bind)));
  const hrefs = {
    tel: `tel:${digits(c.contact.phone)}`,
    sms: `sms:${digits(c.contact.text)}`,
    mailto: `mailto:${c.contact.email}`,
    map: `https://maps.google.com/?q=${encodeURIComponent(c.contact.address)}`,
  };
  document.querySelectorAll("[data-href]").forEach((el) => (el.href = hrefs[el.dataset.href]));

  document.getElementById("hero").style.setProperty("--hero-img", c.hero.image ? `url("${c.hero.image}")` : "none");
  const aboutImg = document.getElementById("about-img");
  aboutImg.src = c.about.image;
  aboutImg.hidden = !c.about.image;
  aboutImg.onerror = () => (aboutImg.hidden = true);

  document.getElementById("stats").innerHTML = c.stats
    .map((s) => `<li><strong>${esc(s.value)}</strong><span>${esc(s.label)}</span></li>`).join("");

  document.getElementById("services-grid").innerHTML = c.services
    .map((s) => `<article class="card"><div class="icon">${esc(s.icon)}</div><h3>${esc(s.title)}</h3><p>${esc(s.text)}</p></article>`).join("");

  document.getElementById("listings-grid").innerHTML = c.listings
    .map((l) => `<article class="listing">
      <div class="ph" style="background-image:url('${esc(l.image)}')">${l.status ? `<span class="badge">${esc(l.status)}</span>` : ""}</div>
      <div class="body"><div class="price">${esc(l.price)}</div><h3>${esc(l.title)}</h3>
      <div class="meta">${esc(l.city)} · ${esc(l.beds)} bd · ${esc(l.baths)} ba · ${esc(l.sqft)} sqft</div></div>
    </article>`).join("");

  document.getElementById("areas").innerHTML = c.areas.map((a) => `<li>${esc(a)}</li>`).join("");

  document.getElementById("team-grid").innerHTML = c.team
    .map((m) => {
      const initials = m.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2);
      const avatar = m.photo
        ? `<div class="avatar" style="background-image:url('${esc(m.photo)}')"></div>`
        : `<div class="avatar">${esc(initials)}</div>`;
      return `<article class="card member">${avatar}<h3>${esc(m.name)}</h3><p>${esc(m.role)}</p>
        <a href="tel:${digits(m.phone)}">${esc(m.phone)}</a><a href="mailto:${esc(m.email)}">${esc(m.email)}</a></article>`;
    }).join("");

  document.getElementById("quotes").innerHTML = c.testimonials
    .map((t) => `<figure class="card"><blockquote>“${esc(t.quote)}”</blockquote><cite>${esc(t.name)}, ${esc(t.place)}</cite></figure>`).join("");

  document.getElementById("social").innerHTML = Object.entries(c.social)
    .filter(([, url]) => url)
    .map(([k, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(k[0].toUpperCase() + k.slice(1))}</a>`).join("");

  document.getElementById("year").textContent = new Date().getFullYear();

  document.getElementById("lead-form").onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = `Name: ${f.get("name")}\nContact: ${f.get("reach")}\nInterested in: ${f.get("interest")}\n\n${f.get("message")}`;
    location.href = `mailto:${c.contact.email}?subject=${encodeURIComponent("Website inquiry: " + f.get("interest"))}&body=${encodeURIComponent(body)}`;
  };
}

const menuBtn = document.querySelector(".menu-btn");
const links = document.querySelector(".links");
menuBtn.onclick = () => menuBtn.setAttribute("aria-expanded", links.classList.toggle("open"));
links.onclick = (e) => e.target.tagName === "A" && links.classList.remove("open");

loadContent().then(render);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
