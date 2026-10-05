// Photoreal talking head streamed over WebRTC by Simli.
// Simli is audio-driven: we hand it the TTS audio (16 kHz PCM16) and it returns lip-synced video + audio,
// so any voice provider works. Requires SIMLI_API_KEY on the server and a server TTS voice.

// The package's index has a case-sensitive import bug, so load the client module directly.
const SIMLI_URL = "https://esm.sh/simli-client@3.0.2/dist/client.js";

export class SimliAvatar {
  consumesAudio = true;

  constructor({ faceId } = {}) {
    this.faceId = faceId;
  }

  async mount(root) {
    root.innerHTML = `<video autoplay playsinline></video><audio autoplay></audio>`;
    this.video = root.querySelector("video");
    this.audio = root.querySelector("audio");

    const r = await fetch("/api/simli/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ faceId: this.faceId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Could not start Simli session");

    const { SimliClient, LogLevel } = await import(SIMLI_URL);
    this.client = new SimliClient(data.sessionToken, this.video, this.audio, data.iceServers, LogLevel?.ERROR);
    this.client.on("error", (d) => console.warn("Simli error:", d));
    await this.client.start();
  }

  /** @param {AudioBuffer} buffer decoded TTS audio at any sample rate */
  async pushAudio(buffer) {
    if (!this.client) return;
    const frames = Math.ceil(buffer.duration * 16000);
    const off = new OfflineAudioContext(1, frames, 16000);
    const src = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination);
    src.start();
    const mono = (await off.startRendering()).getChannelData(0);

    const pcm = new Int16Array(mono.length);
    for (let i = 0; i < mono.length; i++) pcm[i] = Math.max(-1, Math.min(1, mono[i])) * 0x7fff;
    const bytes = new Uint8Array(pcm.buffer);
    const CHUNK = 6000; // ~190 ms per message
    for (let i = 0; i < bytes.length; i += CHUNK) this.client.sendAudioData(bytes.slice(i, i + CHUNK));
  }

  clearAudio() {
    this.client?.ClearBuffer();
  }

  update() {}

  destroy() {
    this.client?.stop().catch(() => {});
    this.video?.remove();
    this.audio?.remove();
  }
}
