// 2D cartoon face drawn in SVG. Mouth follows the voice level; blinks, glances and reacts to state.
const NS = "http://www.w3.org/2000/svg";

export class CartoonAvatar {
  constructor({ color = "#7c5cff" } = {}) {
    this.color = color;
    this.nextBlink = performance.now() + 2000;
    this.blinkUntil = 0;
    this.look = { x: 0, y: 0, tx: 0, ty: 0, next: 0 };
    this.mouth = 0;
  }

  async mount(root) {
    root.innerHTML = `
      <svg viewBox="-200 -200 400 400" preserveAspectRatio="xMidYMid meet">
        <g class="head">
          <ellipse cx="0" cy="150" rx="150" ry="70" class="body"/>
          <circle cx="0" cy="0" r="120" class="face"/>
          <ellipse cx="-62" cy="38" rx="20" ry="11" fill="#ff8fa3" opacity="0.45"/>
          <ellipse cx="62" cy="38" rx="20" ry="11" fill="#ff8fa3" opacity="0.45"/>
          <path class="brow-l" d="M-62 -52 Q-42 -62 -22 -52" stroke="#2b2b2b" stroke-width="7" fill="none" stroke-linecap="round"/>
          <path class="brow-r" d="M22 -52 Q42 -62 62 -52" stroke="#2b2b2b" stroke-width="7" fill="none" stroke-linecap="round"/>
          <g class="eye-l"><ellipse cx="-42" cy="-18" rx="18" ry="22" fill="#fff"/><circle class="pupil" cx="-42" cy="-16" r="10" fill="#222"/></g>
          <g class="eye-r"><ellipse cx="42" cy="-18" rx="18" ry="22" fill="#fff"/><circle class="pupil" cx="42" cy="-16" r="10" fill="#222"/></g>
          <path class="mouth" fill="#5a1d2a" stroke="#2b2b2b" stroke-width="5" stroke-linejoin="round"/>
        </g>
      </svg>`;
    this.svg = root.querySelector("svg");
    this.head = root.querySelector(".head");
    this.eyes = [root.querySelector(".eye-l"), root.querySelector(".eye-r")];
    this.pupils = [...root.querySelectorAll(".pupil")];
    this.brows = [root.querySelector(".brow-l"), root.querySelector(".brow-r")];
    this.mouthEl = root.querySelector(".mouth");
    this.setColor(this.color);
  }

  setColor(color) {
    this.color = color;
    if (!this.svg) return;
    this.svg.querySelector(".face").setAttribute("fill", "#ffd9b8");
    this.svg.querySelector(".body").setAttribute("fill", color);
  }

  update(level, state) {
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
    this.eyes.forEach((e, i) => e.setAttribute("transform", `translate(${i ? 42 : -42} -18) scale(1 ${lid}) translate(${i ? -42 : 42} 18)`));

    // Eyes wander a little; look up and aside while thinking.
    const L = this.look;
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
    this.svg?.remove();
  }
}
