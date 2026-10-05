// Recognizing who is on the call: face (face-api.js, runs fully in the browser) and an
// experimental voice print. Only numeric "prints" are stored (in companion/data/profiles.json), never images or audio.

const FACE_API = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.esm.js";
const FACE_MODELS = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model";
const FACE_MATCH_DISTANCE = 0.5; // lower = stricter

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FaceId {
  async load() {
    if (!this.ready) {
      this.ready = (async () => {
        const api = await import(FACE_API);
        // Prefer the GPU; fall back to plain JS on machines without WebGL.
        if (!(await api.tf.setBackend("webgl").catch(() => false))) await api.tf.setBackend("cpu");
        await api.tf.ready();
        await Promise.all([
          api.nets.tinyFaceDetector.loadFromUri(FACE_MODELS),
          api.nets.faceLandmark68Net.loadFromUri(FACE_MODELS),
          api.nets.faceRecognitionNet.loadFromUri(FACE_MODELS),
        ]);
        this.api = api;
      })();
      this.ready.catch(() => (this.ready = null));
    }
    return this.ready;
  }

  /** Returns a 128-number face descriptor for the main face in the video, or null. */
  async describe(video) {
    await this.load();
    if (!video.videoWidth) return null;
    const api = this.api;
    const det = await api
      .detectSingleFace(video, new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    return det ? Array.from(det.descriptor) : null;
  }

  /** Tries for a few seconds to get a face descriptor. */
  async capture(video, tries = 6) {
    for (let i = 0; i < tries; i++) {
      const d = await this.describe(video);
      if (d) return d;
      await sleep(400);
    }
    return null;
  }

  /** Best matching profile for a descriptor: { profile, distance } or null. */
  match(descriptor, profiles) {
    let best = null;
    for (const p of profiles) {
      for (const f of p.faces || []) {
        let sum = 0;
        for (let i = 0; i < 128; i++) sum += (f[i] - descriptor[i]) ** 2;
        const distance = Math.sqrt(sum);
        if (!best || distance < best.distance) best = { profile: p, distance };
      }
    }
    return best && best.distance < FACE_MATCH_DISTANCE ? best : null;
  }
}

/**
 * Experimental voice print: the average spectral shape of someone's voice across 24 mel bands
 * (mean-normalized) plus how much each band varies. Good enough to tell a few household members
 * apart in a quiet room; not a security feature.
 */
export class VoicePrint {
  static BANDS = 24;
  static MATCH = 0.9; // cosine similarity needed
  static MARGIN = 0.02; // must beat the runner-up by this much

  constructor() {
    this.reset();
  }

  reset() {
    this.sum = new Float64Array(VoicePrint.BANDS);
    this.sumSq = new Float64Array(VoicePrint.BANDS);
    this.frames = 0;
  }

  async start(shouldListen = () => true) {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    src.connect(this.analyser);
    const time = new Float32Array(this.analyser.fftSize);
    const freq = new Float32Array(this.analyser.frequencyBinCount);
    const bands = this.melBands(this.ctx.sampleRate, this.analyser.fftSize);

    this.timer = setInterval(() => {
      if (!shouldListen()) return;
      this.analyser.getFloatTimeDomainData(time);
      let e = 0;
      for (const v of time) e += v * v;
      if (Math.sqrt(e / time.length) < 0.02) return; // only voiced frames
      this.analyser.getFloatFrequencyData(freq);
      const frame = bands.map(([lo, hi]) => {
        let s = 0;
        for (let i = lo; i < hi; i++) s += 10 ** (freq[i] / 10);
        return Math.log10(s / (hi - lo) + 1e-12);
      });
      const mean = frame.reduce((a, b) => a + b, 0) / frame.length;
      frame.forEach((v, i) => {
        const x = v - mean; // remove overall loudness, keep spectral shape
        this.sum[i] += x;
        this.sumSq[i] += x * x;
      });
      this.frames++;
    }, 30);
  }

  stop() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.stream = this.ctx = null;
  }

  melBands(sampleRate, fftSize) {
    const mel = (f) => 2595 * Math.log10(1 + f / 700);
    const inv = (m) => 700 * (10 ** (m / 2595) - 1);
    const lo = mel(90);
    const hi = mel(5000);
    const binHz = sampleRate / fftSize;
    const edges = Array.from({ length: VoicePrint.BANDS + 1 }, (_, i) => Math.round(inv(lo + ((hi - lo) * i) / VoicePrint.BANDS) / binHz));
    return edges.slice(0, -1).map((e, i) => [e, Math.max(e + 1, edges[i + 1])]);
  }

  /** Seconds of voiced audio collected so far. */
  get seconds() {
    return (this.frames * 30) / 1000;
  }

  /** Normalized print vector, or null if not enough speech yet. */
  print(minSeconds = 3) {
    if (this.seconds < minSeconds) return null;
    const n = this.frames;
    const v = [];
    for (let i = 0; i < VoicePrint.BANDS; i++) v.push(this.sum[i] / n);
    for (let i = 0; i < VoicePrint.BANDS; i++) v.push(Math.sqrt(Math.max(0, this.sumSq[i] / n - (this.sum[i] / n) ** 2)));
    const len = Math.hypot(...v) || 1;
    return v.map((x) => x / len);
  }

  match(print, profiles) {
    const scores = profiles
      .map((p) => ({
        profile: p,
        score: Math.max(-1, ...(p.voices || []).filter((v) => v.length === print.length).map((v) => v.reduce((s, x, i) => s + x * print[i], 0))),
      }))
      .filter((s) => s.score > -1)
      .sort((a, b) => b.score - a.score);
    const [best, next] = scores;
    if (!best || best.score < VoicePrint.MATCH) return null;
    if (next && best.score - next.score < VoicePrint.MARGIN) return null;
    return best;
  }
}
