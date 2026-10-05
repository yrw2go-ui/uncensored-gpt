// Voice output (Speaker) and voice input (Listener).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Speaks queued sentences one after another and exposes a 0..1 mouth level for lip-sync.
 * - "browser" TTS uses speechSynthesis (free; mouth movement is simulated).
 * - Server TTS (elevenlabs / openai) returns audio that is played through Web Audio,
 *   so the mouth follows the real loudness. If the avatar consumes audio itself
 *   (photoreal / Simli) the audio is handed to it instead of played locally.
 */
export class Speaker {
  constructor({ getAvatar, onStart, onEnd, onError }) {
    this.getAvatar = getAvatar;
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.onError = onError;
    this.provider = "browser";
    this.voice = "";
    this.ctx = null;
    this.analyser = null;
    this.queue = [];
    this.gen = 0; // bumps on stop() to invalidate in-flight work
    this.running = false;
    this.current = null;
    this.fakeTalk = false;
    this.data = null;
  }

  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(this.ctx.destination);
      this.data = new Float32Array(this.analyser.fftSize);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  get speaking() {
    return this.running;
  }

  /** Current mouth openness, 0..1. */
  level() {
    if (this.fakeTalk) {
      const t = performance.now() / 1000;
      return 0.25 + 0.45 * Math.abs(Math.sin(t * 11)) * (0.6 + 0.4 * Math.sin(t * 3.7));
    }
    if (!this.analyser || !this.current) return 0;
    this.analyser.getFloatTimeDomainData(this.data);
    let sum = 0;
    for (const v of this.data) sum += v * v;
    return Math.min(1, Math.sqrt(sum / this.data.length) * 6);
  }

  say(text) {
    text = text.trim();
    if (!text) return;
    const gen = this.gen;
    const job = { text };
    if (this.provider !== "browser") {
      job.audio = this.fetchAudio(text, gen); // prefetch while earlier lines play
      job.audio.catch(() => {}); // errors surface when the job is played
    }
    this.queue.push(job);
    if (!this.running) this.run(gen);
  }

  async fetchAudio(text, gen) {
    const r = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, provider: this.provider, voice: this.voice }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `TTS failed (${r.status})`);
    const bytes = await r.arrayBuffer();
    if (gen !== this.gen) return null;
    return this.ctx.decodeAudioData(bytes);
  }

  async run(gen) {
    this.running = true;
    this.onStart?.();
    let avatarBusyUntil = 0;
    try {
      while (this.queue.length && gen === this.gen) {
        const job = this.queue.shift();
        if (this.provider === "browser") {
          await this.speakBrowser(job.text, gen);
          continue;
        }
        const buffer = await job.audio;
        if (!buffer || gen !== this.gen) break;
        const avatar = this.getAvatar();
        if (avatar?.consumesAudio) {
          // Photoreal avatar plays the audio in sync with its video; we just keep time.
          await avatar.pushAudio(buffer);
          avatarBusyUntil = Math.max(performance.now(), avatarBusyUntil) + buffer.duration * 1000;
          while (!this.queue.length && gen === this.gen && performance.now() < avatarBusyUntil) await sleep(50);
        } else {
          await this.playBuffer(buffer);
        }
      }
    } catch (e) {
      this.onError?.(e);
    } finally {
      if (gen === this.gen) {
        this.queue = [];
        this.running = false;
        this.current = null;
        this.onEnd?.();
      }
    }
  }

  playBuffer(buffer) {
    return new Promise((resolve) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.analyser);
      src.onended = () => {
        if (this.current === src) this.current = null;
        resolve();
      };
      this.current = src;
      src.start();
    });
  }

  speakBrowser(text, gen) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) {
        const v = speechSynthesis.getVoices().find((x) => x.name.toLowerCase().includes(this.voice.toLowerCase()));
        if (v) u.voice = v;
      }
      const done = () => {
        this.fakeTalk = false;
        resolve();
      };
      u.onstart = () => (this.fakeTalk = gen === this.gen);
      u.onend = done;
      u.onerror = done;
      speechSynthesis.speak(u);
    });
  }

  /** Stop talking immediately (barge-in / interrupt). */
  stop() {
    this.gen++;
    this.queue = [];
    try {
      this.current?.stop();
    } catch {}
    this.current = null;
    this.fakeTalk = false;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.getAvatar()?.clearAudio?.();
    if (this.running) {
      this.running = false;
      this.onEnd?.();
    }
  }
}

/**
 * Listens to the microphone and emits final utterances.
 * - "browser": Web Speech API (Chrome / Edge), streaming and free.
 * - "server": simple energy-based VAD records each utterance and sends it to /api/stt (Whisper-style).
 */
export class Listener {
  constructor({ onSpeechStart, onInterim, onFinal, onError }) {
    this.onSpeechStart = onSpeechStart;
    this.onInterim = onInterim;
    this.onFinal = onFinal;
    this.onError = onError;
    this.mode = "browser";
    this.active = false;
    this.muted = false;
  }

  static browserSupported() {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  async start(mode) {
    this.stop();
    this.mode = mode;
    this.active = true;
    if (mode === "browser") this.startBrowser();
    else await this.startServer();
  }

  stop() {
    this.active = false;
    try {
      this.rec?.abort();
    } catch {}
    this.rec = null;
    cancelAnimationFrame(this.raf);
    this.recorder?.state === "recording" && this.recorder.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.vadCtx?.close();
    this.vadCtx = null;
  }

  setMuted(m) {
    this.muted = m;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !m));
    if (this.mode === "browser") {
      if (m) this.rec?.abort();
      else if (this.active && !this.rec) this.startBrowser();
    }
  }

  startBrowser() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return this.onError?.(new Error("This browser has no speech recognition. Use Chrome/Edge or set STT_BASE_URL."));
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    let started = false;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          started = false;
          const text = r[0].transcript.trim();
          if (text) this.onFinal?.(text);
        } else interim += r[0].transcript;
      }
      if (interim.trim()) {
        if (!started) {
          started = true;
          this.onSpeechStart?.(interim);
        }
        this.onInterim?.(interim);
      }
    };
    rec.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") this.onError?.(new Error(`Speech recognition: ${e.error}`));
    };
    // Chrome stops recognition periodically; restart while the call is active.
    rec.onend = () => {
      if (this.rec === rec) this.rec = null;
      if (this.active && !this.muted && this.mode === "browser") setTimeout(() => this.active && !this.rec && this.startBrowser(), 250);
    };
    this.rec = rec;
    rec.start();
  }

  async startServer() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.vadCtx = new AudioContext();
    const src = this.vadCtx.createMediaStreamSource(this.stream);
    const analyser = this.vadCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    const THRESH = 0.02; // RMS needed to count as speech
    const START_MS = 120; // speech must last this long to start a recording
    const END_MS = 800; // this much silence ends the utterance
    let loudSince = 0;
    let quietSince = 0;
    let recording = false;

    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );

    const begin = () => {
      recording = true;
      const chunks = [];
      const recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => this.transcribe(new Blob(chunks, { type: recorder.mimeType }));
      recorder.start();
      this.recorder = recorder;
      this.onSpeechStart?.("");
    };

    const tick = () => {
      if (!this.active) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      if (!this.muted && rms > THRESH) {
        quietSince = 0;
        loudSince ||= now;
        if (!recording && now - loudSince > START_MS) begin();
      } else {
        loudSince = 0;
        quietSince ||= now;
        if (recording && now - quietSince > END_MS) {
          recording = false;
          this.recorder.stop();
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  async transcribe(blob) {
    if (blob.size < 2000) return; // too short to be speech
    try {
      const r = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "STT failed");
      if (data.text?.trim()) this.onFinal?.(data.text.trim());
    } catch (e) {
      this.onError?.(e);
    }
  }
}
