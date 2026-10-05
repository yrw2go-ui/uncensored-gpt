// Synthesized phone sounds (no audio files needed).
// "incoming": a friendly marimba-style ringtone + vibration. "outgoing": the classic ringback tone.
let ctx;
let timer;
let nodes = [];

function audio() {
  ctx ||= new AudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function tone(freq, start, dur, gain = 0.2, type = "sine") {
  const a = audio();
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, start + dur);
  osc.connect(g).connect(a.destination);
  osc.start(start);
  osc.stop(start + dur + 0.05);
  nodes.push(osc);
}

function incomingPattern() {
  const t = audio().currentTime + 0.05;
  [659, 784, 988, 784, 659, 784, 988, 1175].forEach((f, i) => tone(f, t + i * 0.16, 0.4, 0.18, "triangle"));
  navigator.vibrate?.([500, 200, 500]);
}

function outgoingPattern() {
  const t = audio().currentTime + 0.05;
  tone(440, t, 2, 0.08); // North American ringback: 440 + 480 Hz, 2 s on, 4 s off
  tone(480, t, 2, 0.08);
}

export function startRing(kind) {
  stopRing();
  const play = kind === "incoming" ? incomingPattern : outgoingPattern;
  play();
  timer = setInterval(play, kind === "incoming" ? 2600 : 4000);
}

export function stopRing() {
  clearInterval(timer);
  nodes.forEach((n) => {
    try {
      n.stop();
    } catch {}
  });
  nodes = [];
  navigator.vibrate?.(0);
}

export function hangupBeep() {
  const t = audio().currentTime + 0.02;
  tone(480, t, 0.15, 0.1);
  tone(480, t + 0.22, 0.15, 0.1);
}
