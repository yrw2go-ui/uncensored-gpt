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

**One-way calls:** in Settings, untick "Start with my mic on" and "Start with my camera on". The character is on video and talks to you; you type in the box under the video. You can switch your mic or camera on or off at any point.

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
- `<think>…</think>` reasoning is stripped before speaking, so reasoning models work too.
- **Let it see me** attaches a webcam snapshot to each message. Use it only with a vision-capable model.

## Characters (Character tab)

- **Create with AI:** describe anyone ("a retired pirate grandma who loves gardening"). The selected LLM writes their name, personality, backstory, speaking style, likes and dislikes, greeting, trait dials and cartoon look (skin, hair and style, eyes, shirt, glasses).
- **Tweak with AI:** for example "make her more sarcastic and obsessed with cats". It edits the character and keeps everything else.
- **Edit by hand:** every field, six trait sliders (warmth, humor, sarcasm, energy, curiosity, formality), face type, and a per-character voice. Changes save automatically and apply live, mid-call.
- **Full prompt sent to the model** shows exactly what the LLM receives.
- Characters are stored in `data/characters.json`. The four starters come from `characters.seed.json`.

## Remembering you (You tab)

- **Profiles:** each person is a profile (name). Pick one, or let recognition pick it.
- **Learning:** every 5 messages, and when a call ends, the LLM pulls lasting facts about you from the conversation ("Has a dog named Biscuit") and updates that character's relationship summary. Facts are shared by all characters. Each character keeps its own relationship and chat history. Later calls bring this up naturally ("How's Biscuit?").
- **Strangers:** as a guest, the character asks your name. When you say it, a profile is created automatically, and your face and voice prints are attached if recognition is on.
- **Face recognition:** [face-api.js](https://github.com/vladmandic/face-api) runs in the browser. Click "Teach my face", or let it learn you as above. With the camera on, it recognizes you at the start of a call and greets you by name.
- **Voice recognition (experimental):** a simple voiceprint based on the shape of your voice's frequencies. It can tell a few people in a household apart in a quiet room. It's not secure, and face or name are more reliable.
- You can see, add and delete every remembered fact, edit the relationship summary, or wipe it all.

**Privacy:** everything stays in `companion/data/` on the machine running the server. For faces and voices, only numeric prints are saved, never photos or audio. Get people's consent before enrolling them. Biometric data is regulated in some places (for example under GDPR, or Illinois' BIPA).

## Voice and ears

| | Free default | Upgrade (`.env`) |
|---|---|---|
| Voice (TTS) | Browser `speechSynthesis` | `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID`, or any OpenAI-compatible `/audio/speech` via `TTS_BASE_URL` (OpenAI, Kokoro-FastAPI…) |
| Ears (STT) | Browser speech recognition (Chrome/Edge) | Any OpenAI-compatible `/audio/transcriptions` via `STT_BASE_URL` (OpenAI Whisper, Groq, faster-whisper-server…), using built-in voice-activity detection |

## Files

```
server.js            zero-dependency Node server; keeps API keys server-side
providers.json       LLM providers + default model lists
characters.seed.json starter characters (copied into data/ on first run)
lib/                 JSON file store + LLM helpers
data/                your characters, profiles and memories (git-ignored)
public/index.html    call UI (stage, self-view, controls, settings panel)
public/js/app.js     the conversation loop, sentence streaming, barge-in, memory
public/js/speech.js  Speaker (TTS queue + lip-sync level) and Listener (STT + VAD)
public/js/character.js   builds the system prompt from a character + memories
public/js/recognition.js face recognition and voiceprints
public/js/avatars/   cartoon.js, vrm.js, simli.js; each implements mount / update / destroy
```

Adding another face (Live2D, a HeyGen/Tavus stream, your own model) means one new file in `avatars/` with `mount(root)`, `update(mouthLevel, state)` and `destroy()`. If the avatar plays audio itself, also add `consumesAudio = true`, `pushAudio(AudioBuffer)` and `clearAudio()`.
