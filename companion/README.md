# AI Companion: a live "video call" with an AI

A real-time companion you can talk to like a Zoom call. You speak, it answers out loud, and a face lip-syncs to its voice. You can switch between three kinds of face and several LLMs while you talk.

```
mic ─► speech-to-text ─► LLM (streamed) ─► sentence queue ─► text-to-speech ─► avatar (lip-sync)
 ▲                                                                                  │
 └──────────── talking over it interrupts (barge-in) ◄──────────────────────────────┘
```

## Quick start

```bash
cd companion
cp .env.example .env        # put your ATLASCLOUD_API_KEY in it
npm start                   # no npm install needed, Node 18+
```

Open http://localhost:8787 in **Chrome or Edge**, click **Start call** and allow the mic. Headphones stop it from hearing (and interrupting) itself.

With only an Atlas Cloud key you get the cartoon and 3D avatars, the browser's free voice and free speech recognition. Adding more keys unlocks better voices and the photoreal face.

## The three faces

| Mode | How it works | What it needs |
|---|---|---|
| **Cartoon** | SVG face. The mouth follows voice loudness, with blinking, glances, head tilt and bob | Nothing |
| **3D** | Any `.vrm` model (VRoid Studio / VRoid Hub) rendered with three.js + three-vrm. Drives the `aa`/`oh` visemes, blink and head motion | Set a VRM URL in the panel or `VRM_URL`, or **drag a .vrm file onto the video** |
| **Photoreal** | [Simli](https://simli.com) streams a lip-synced real face over WebRTC. We send it the TTS audio, so it works with any voice | `SIMLI_API_KEY`, a face ID, and a server voice (ElevenLabs or OpenAI-compatible) |

The browser voice can't be captured as audio. So with it, the cartoon and 3D mouths use simulated movement, and photoreal mode isn't available. With a server voice, lip-sync follows the real audio.

## LLMs ("brains")

`providers.json` lists every OpenAI-compatible provider. Atlas Cloud is pre-filled with a few models:

- Pick a **provider** and a **model** in the side panel. You can switch mid-conversation; the memory carries over.
- **Load all** fetches every model that provider offers (`GET /v1/models`), so you can try any of them. You can also type any model ID by hand.
- Add more providers by adding an entry to `providers.json` with `baseURL`, `apiKeyEnv` and `models`. Groq, Together, OpenRouter, a local Ollama and LM Studio all work.
- **Personas** (`personas.json`) are starting system prompts. Edit the prompt live in the panel.
- `<think>…</think>` reasoning is stripped before speaking, so reasoning models work too.
- **Let it see me** attaches a webcam snapshot to each message. Use it only with a vision-capable model.

## Voice and ears

| | Free default | Upgrade (`.env`) |
|---|---|---|
| Voice (TTS) | Browser `speechSynthesis` | `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`, or any OpenAI-compatible `/audio/speech` via `TTS_BASE_URL` (OpenAI, Kokoro-FastAPI…) |
| Ears (STT) | Browser speech recognition (Chrome/Edge) | Any OpenAI-compatible `/audio/transcriptions` via `STT_BASE_URL` (OpenAI Whisper, Groq, faster-whisper-server…), using built-in voice-activity detection |

## Files

```
server.js            zero-dependency Node server; keeps API keys server-side
providers.json       LLM providers + default model lists
personas.json        personalities / system prompts
public/index.html    call UI (stage, self-view, controls, settings panel)
public/js/app.js     the conversation loop, sentence streaming, barge-in, memory
public/js/speech.js  Speaker (TTS queue + lip-sync level) and Listener (STT + VAD)
public/js/avatars/   cartoon.js, vrm.js, simli.js; each implements mount / update / destroy
```

Adding another face (Live2D, a HeyGen/Tavus stream, your own model) means one new file in `avatars/` with `mount(root)`, `update(mouthLevel, state)` and `destroy()`. If the avatar plays audio itself, also add `consumesAudio = true`, `pushAudio(AudioBuffer)` and `clearAudio()`.

## Memory

The last 40 messages are kept in the browser (localStorage) and sent with each turn; **Clear memory** wipes them. A good next step is long-term memory: summarise old turns into facts and store them server-side.
