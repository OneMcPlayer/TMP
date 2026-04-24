# Realtime Browser Call Lab

This is a separate local backend for testing whether a true browser `WebRTC` session behaves better on iPhone Safari than the older PWA upload / STT / TTS chain.

## What it does

- accepts a browser SDP offer from the side-experiment page
- forwards that offer to OpenAI Realtime via `POST /v1/realtime/calls`
- returns the SDP answer to the browser
- opens a sideband WebSocket to the same call
- logs sideband events, errors, and session updates
- accepts browser-side client debug logs for active sessions
- exposes those logs back to the browser page for export

## Environment

Set your API key before starting the server:

```bash
export OPENAI_API_KEY=sk-...
```

## Run

```bash
npm run realtime-lab:server
```

The default local port is `8787`.

## Browser page

The matching browser page lives in the main app at:

- `#/realtime-lab`
- `#/tap-rehearsal`

You can keep the normal Vite app running separately with:

```bash
npm run dev
```

Then point the browser page at:

- `http://127.0.0.1:8787`

Or, when using Codespaces / a forwarded public port:

- `https://<your-codespace>-8787.<forwarding-domain>`

## Tap Rehearsal Route

The `#/tap-rehearsal` route reuses this backend with a stricter rehearsal contract:

- `turnCommitMode: "manual"` disables automatic VAD turn commits
- the browser sends `input_audio_buffer.clear` when the user turn opens
- the browser sends `input_audio_buffer.commit` when the user taps the large line-complete button
- `correctionMode: "reveal-and-retry"` speaks and shows the expected line after a miss without advancing the script

## Client Log Uploads

Backend-assisted pages automatically POST browser debug events to:

- `/api/realtime-webrtc/sessions/:sessionId/client-logs`

Those client events are folded into the same session log stream returned by:

- `/api/realtime-webrtc/sessions/:sessionId/logs`

If the client no longer shows the session ID, use the recent-session index:

- `/api/realtime-webrtc/sessions`

The backend also appends every session log entry to:

- `output/realtime-session-logs.jsonl`

Override that location with `REALTIME_SESSION_LOG_FILE=/path/to/file.jsonl` when starting the backend.

That makes a backend log export useful without manually copying the client report after every run.

## Why this exists

The repo findings showed that Safari standalone PWA mode was especially fragile with:

- delayed `audio.play()`
- playback-to-recording handoff
- media-session activation order

This experiment changes the transport entirely:

- one tap
- persistent mic capture
- real-time WebRTC session
- live remote audio stream
- backend-side session logging

The goal is to learn whether that architecture feels more like a browser call app and less like the old request / response audio chain.
