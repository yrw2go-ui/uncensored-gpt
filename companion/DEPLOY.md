# Deploying AI Companion

## What a host needs to provide

| Need | Why |
|---|---|
| **Always on** (no sleeping) | So characters can call you on schedule |
| **Persistent disk** mounted at `/data` | Characters, profiles and memories are saved there |
| **HTTPS** | Phones only allow camera, mic and notifications on HTTPS |
| **One instance** | Data is stored in files and the call scheduler runs in-process |

The app also needs a password (`APP_PASSWORD`). On hosting platforms it refuses to start without one, so nobody else can spend your API credits or read your memories.

## Railway (recommended)

**Cost:** the Hobby plan is $5/month and includes $5 of usage, which covers this app. Atlas Cloud, ElevenLabs and Simli usage is billed separately by those services.

1. Go to [railway.com](https://railway.com) and sign in with GitHub.
2. **New Project → Deploy from GitHub repo →** `yrw2go-ui/uncensored-gpt`.
   - If Railway can't see the repo, click **Configure GitHub App** and give it access.
3. Open the new service → **Settings → Source**:
   - **Root Directory:** `companion`
   - **Branch:** `ccr-ad6f44a0-7bjxil` (or `main` once you've merged this work)
4. **Variables** tab, add:
   | Variable | Value |
   |---|---|
   | `APP_PASSWORD` | a long password you'll type once per device |
   | `ATLASCLOUD_API_KEY` | your Atlas Cloud key |
   | `VAPID_SUBJECT` | `mailto:you@yourdomain.com` (a real address; Apple rejects placeholders) |
   | *optional* `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | better voices |
   | *optional* `SIMLI_API_KEY`, `SIMLI_FACE_ID` | photoreal face |
5. Add a **volume**: right-click the service on the canvas (or press ⌘K / Ctrl+K) → **Add Volume** → mount path **`/data`**.
6. **Settings → Networking → Generate Domain.** You get `https://<something>.up.railway.app`.
7. Wait for the deploy to turn green, then open the link and sign in.

**On your phone:** open the link → sign in → **Add to Home Screen** → open it from the Home Screen → *Character → Ring this device when they call* → *Test: call me in 10 s*, then lock your phone.

Every push to the branch redeploys automatically. Your data on the volume is kept.

## Any other Docker host (Fly.io, Render, a VPS…)

```bash
cd companion
docker build -t ai-companion .
docker run -d --restart unless-stopped -p 8787:8787 \
  -v companion-data:/data \
  -e APP_PASSWORD=change-me -e ATLASCLOUD_API_KEY=... -e VAPID_SUBJECT=mailto:you@example.com \
  ai-companion
```

Put HTTPS in front of it, using Caddy, the platform's proxy, or `HTTPS_CERT`/`HTTPS_KEY`.

- **Render:** use a paid instance with a persistent disk at `/data`; the free tier sleeps and has no disk.
- **Fly.io:** create a volume, mount it at `/data`, and keep one machine always running.

## Backups

Everything you'd miss lives in `/data`: `characters.json`, `profiles.json`, and `facts_*` / `rel_*` (memories). On Railway you can turn on volume backups in the volume's settings.

## Updating your password

Change `APP_PASSWORD` and redeploy. Every device is signed out and has to sign in again.
