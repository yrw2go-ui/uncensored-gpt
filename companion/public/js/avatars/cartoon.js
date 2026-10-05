// 2D cartoon face drawn in SVG. Its look comes from the character (skin, hair, eyes, shirt, glasses).
// The mouth follows the voice level; it blinks, glances and reacts to the call state.

const HAIR_BACK = {
  long: `<path d="M-132 -20 Q-142 -142 0 -142 Q142 -142 132 -20 L146 150 Q0 172 -146 150 Z"/>`,
  bun: `<circle cx="0" cy="-138" r="42"/>`,
  curly: "",
  short: "",
  spiky: "",
  none: "",
};

const CAP = `<path d="M-123 -8 Q-128 -128 0 -131 Q128 -128 123 -8 Q104 -72 42 -84 Q0 -62 -42 -86 Q-104 -72 -123 -8Z"/>`;
const HAIR_FRONT = {
  short: CAP,
  long: CAP,
  bun: CAP,
  spiky: `<path d="M-122 -25 L-118 -100 L-88 -92 L-74 -140 L-40 -112 L-12 -156 L14 -116 L48 -146 L70 -102 L104 -116 L122 -25 Q70 -86 0 -82 Q-70 -86 -122 -25Z"/>`,
  curly: Array.from({ length: 11 }, (_, i) => {
    const a = Math.PI * (1.05 + (i / 10) * 0.9);
    return `<circle cx="${Math.cos(a) * 112}" cy="${Math.sin(a) * 104 - 6}" r="34"/>`;
  }).join(""),
  none: "",
};

export class CartoonAvatar {
  constructor({ look = {} } = {}) {
    this.look = look;
    this.nextBlink = performance.now() + 2000;
    this.blinkUntil = 0;
    this.lookAt = { x: 0, y: 0, tx: 0, ty: 0, next: 0 };
    this.mouth = 0;
  }

  async mount(root) {
    this.root = root;
    this.render();
  }

  setLook(look) {
    this.look = look;
    if (this.root) this.render();
  }

  render() {
    const L = { skin: "#f2c9a5", hair: "#3b2a20", hairStyle: "short", eyes: "#3d3d3d", shirt: "#7c5cff", ...this.look };
    const eye = (x) => `
      <g class="eye" data-x="${x}">
        <ellipse cx="${x}" cy="-18" rx="18" ry="22" fill="#fff"/>
        <g class="pupil"><circle cx="${x}" cy="-15" r="11" fill="${L.eyes}"/><circle cx="${x}" cy="-15" r="5.5" fill="#111"/><circle cx="${x + 4}" cy="-20" r="3" fill="#fff"/></g>
      </g>`;
    this.root.innerHTML = `
      <svg viewBox="-200 -200 400 400" preserveAspectRatio="xMidYMid meet">
        <g class="head">
          <g fill="${L.hair}">${HAIR_BACK[L.hairStyle] || ""}</g>
          <path d="M-150 700 L-150 220 Q-150 110 0 100 Q150 110 150 220 L150 700 Z" fill="${L.shirt}"/>
          <rect x="-26" y="80" width="52" height="40" fill="${L.skin}"/>
          <circle cx="0" cy="0" r="120" fill="${L.skin}"/>
          <ellipse cx="-62" cy="38" rx="20" ry="11" fill="#ff8fa3" opacity="0.35"/>
          <ellipse cx="62" cy="38" rx="20" ry="11" fill="#ff8fa3" opacity="0.35"/>
          ${eye(-42)}${eye(42)}
          <path class="brow" d="M-62 -52 Q-42 -62 -22 -52" stroke="${L.hair}" stroke-width="7" fill="none" stroke-linecap="round"/>
          <path class="brow" d="M22 -52 Q42 -62 62 -52" stroke="${L.hair}" stroke-width="7" fill="none" stroke-linecap="round"/>
          ${
            L.glasses
              ? `<g fill="none" stroke="#222" stroke-width="5"><circle cx="-42" cy="-16" r="30"/><circle cx="42" cy="-16" r="30"/><path d="M-12 -18 Q0 -26 12 -18"/></g>`
              : ""
          }
          <path class="mouth" fill="#5a1d2a" stroke="#2b2b2b" stroke-width="5" stroke-linejoin="round"/>
          <g fill="${L.hair}">${HAIR_FRONT[L.hairStyle] || ""}</g>
        </g>
      </svg>`;
    this.head = this.root.querySelector(".head");
    this.eyes = [...this.root.querySelectorAll(".eye")];
    this.pupils = [...this.root.querySelectorAll(".pupil")];
    this.brows = [...this.root.querySelectorAll(".brow")];
    this.mouthEl = this.root.querySelector(".mouth");
  }

  update(level, state) {
    if (!this.mouthEl) return;
    const now = performance.now();
    const t = now / 1000;

    // Mouth: smooth toward the target so it doesn't jitter.
    this.mouth += (level - this.mouth) * 0.5;
    const open = 4 + this.mouth * 46;
    const w = 34 - this.mouth * 8;
    const smile = state === "speaking" ? 6 : 12;
    this.mouthEl.setAttribute(
      "d",
      `M${-w} 58 Q0 ${58 + smile} ${w} 58 Q${w * 0.7} ${58 + open} 0 ${58 + open + 4} Q${-w * 0.7} ${58 + open} ${-w} 58 Z`,
    );

    // Blinking
    if (now > this.nextBlink) {
      this.blinkUntil = now + 130;
      this.nextBlink = now + 2000 + Math.random() * 4000;
    }
    const lid = now < this.blinkUntil ? 0.08 : 1;
    this.eyes.forEach((e) => {
      const x = Number(e.dataset.x);
      e.setAttribute("transform", `translate(${x} -18) scale(1 ${lid}) translate(${-x} 18)`);
    });

    // Eyes wander a little; look up and aside while thinking.
    const L = this.lookAt;
    if (now > L.next) {
      L.tx = state === "thinking" ? 6 : (Math.random() - 0.5) * 8;
      L.ty = state === "thinking" ? -7 : (Math.random() - 0.5) * 5;
      L.next = now + 600 + Math.random() * 2200;
    }
    L.x += (L.tx - L.x) * 0.15;
    L.y += (L.ty - L.y) * 0.15;
    this.pupils.forEach((p) => p.setAttribute("transform", `translate(${L.x} ${L.y})`));

    // Brows lift when listening or thinking.
    const lift = state === "listening" ? -6 : state === "thinking" ? -10 : 0;
    this.brows.forEach((b) => b.setAttribute("transform", `translate(0 ${lift})`));

    // Head motion: gentle idle sway, a bob while speaking, a tilt while listening.
    const tilt = state === "listening" ? 5 : Math.sin(t * 0.8) * 2;
    const bob = state === "speaking" ? Math.sin(t * 6) * 3 * this.mouth : Math.sin(t * 1.5) * 2;
    this.head.setAttribute("transform", `translate(0 ${bob}) rotate(${tilt})`);
  }

  destroy() {
    if (this.root) this.root.innerHTML = "";
  }
}
