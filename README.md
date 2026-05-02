# Finale di partita Rehearsal Partner

A browser-only rehearsal page for **Finale di partita** by Samuel Beckett. It is built as a static Vite app and is ready to publish on **GitHub Pages**.

## Features

- Memory-style rehearsal with your own lines hidden until it is your turn
- OpenAI text-to-speech for the other character's lines
- OpenAI speech-to-text for your spoken lines
- Correction rules that ignore punctuation and anything inside parentheses
- Optional spoken correction playback when your line is wrong
- Larger-control **car mode** for quick phone use
- Installable **PWA** shell for home-screen use
- Car-mode **screen wake lock** when the browser supports it
- Debug logs that capture **PWA**, **service worker**, and mobile runtime state
- A separate **Realtime Browser Lab** route for testing a true browser-call architecture with a local backend
- A separate **Tap Rehearsal** route for backend-managed rehearsal with hidden user lines and one large line-complete button
- Automatic client debug-log upload for backend-assisted realtime sessions, so server logs include browser-side events
- A selectable rehearsal text list, including the original **Finale di partita** text and **Processo al Potere**

## Car Mode Note

This is still a standard web page, so it does **not** have native Apple CarPlay integration or access to CarPlay-specific system UI. The included **car mode** is a browser-side layout and recording mode designed to be easier to use from your phone while connected in the car.

On browsers that expose the Media Session API, car mode also listens for the car's **next track** and **previous track** controls so you can move line-by-line without touching the screen as often.
On browsers that expose the Screen Wake Lock API, car mode also tries to keep the phone screen awake while rehearsal is active. If wake lock is unavailable, keep the phone unlocked and connected to power for the most reliable experience.

## Script Format

The app supports either legacy `character`/`text` lines or `speaker`/`line` lines. The bundled default script is configured for **Finale di partita** in `client/public/script.json`, and additional selectable texts live under `client/public/scripts/`.

Example:

```json
{
  "title": "FINALE DI PARTITA",
  "author": "Samuel Beckett",
  "language": "it",
  "lines": [
    { "speaker": "CLOV", "line": "Finita, è finita..." }
  ]
}
```

## Local Development

```bash
npm install
npm run dev
```

## Realtime Browser Experiment

There is now a side experiment for testing whether a true browser `WebRTC` call behaves better on iPhone Safari than the older upload / STT / TTS chain.

Browser page:

- `#/realtime-lab`
- `#/tap-rehearsal` for the stage-style tap prototype

Local backend:

```bash
export OPENAI_API_KEY=sk-...
npm run realtime-lab:server
```

The backend helper lives in [experiments/realtime-webrtc-lab/README.md](/workspaces/TMP/experiments/realtime-webrtc-lab/README.md). This experiment is intentionally separate from the static GitHub Pages deployment so we can test a backend-assisted call flow without destabilizing the main rehearsal app.

## Tap Rehearsal Prototype

The tap prototype uses the same local realtime backend but changes the rehearsal loop:

- partner lines are spoken automatically
- user lines are not shown during normal play
- the browser records each user turn locally, then uploads the audio clip to the backend for transcription and scoring
- the user taps one large button after finishing the line
- wrong lines reveal and speak the correction, then the user can retry or skip

Realtime backend sessions also receive client debug logs automatically from the browser. Use the backend session logs when sharing a run; copying the client-side report is only needed as a fallback.
If the page no longer shows the session ID after cleanup, open `/api/realtime-webrtc/sessions` on the backend to find recent sessions and their log URLs.
The local backend also writes session logs to `output/realtime-session-logs.jsonl` for direct server-side inspection.
Pre-session browser logs are written there too once a backend URL is configured, so failed start attempts do not require copying the client report.

## Local Diagnostics

No external error service is required. Backend-assisted pages install a local browser diagnostic collector that sends crash/error snapshots to the realtime backend when a backend URL is configured.

Captured snapshots include app version, route, session ID, call ID, tap state, browser/runtime info, and recent debug breadcrumbs. Audio is never sent, and transcript/script-like fields are redacted before they are written.

Useful backend endpoints:

- `GET /api/realtime-webrtc/diagnostics`
- `POST /api/realtime-webrtc/diagnostics`
- `POST /api/realtime-webrtc/sessions/:sessionId/diagnostics`

Diagnostics are also appended to `output/realtime-session-logs.jsonl`, so they can be inspected directly on the server next to the normal session logs.

## Quality Checks

Run the full local validation suite (typecheck + unit tests + scenario tests + real browser e2e + production build):

```bash
npm run test:full
```

Browser e2e is powered by Playwright. Install Chromium once before the first run:

```bash
npx playwright install chromium
```

You can also run checks individually with `npm run check`, `npm test`, `npm run test:logic`, `npm run test:e2e`, and `npm run build`.

## Production Build

```bash
npm run build
```

The static output is written to `dist/`.

## GitHub Pages Deployment

This repo already includes `.github/workflows/deploy.yml`.

1. Push the repository to GitHub.
2. Open **Settings > Pages** in the GitHub repository.
3. Set the source to **GitHub Actions**.
4. Push to `main`.

The workflow will build the app and deploy `dist/` to GitHub Pages automatically.

## Personal Use Notes

- Your OpenAI API key is stored only in `localStorage` on the device you use.
- There is no backend server in this setup.
- Spoken correction mode is especially useful when you do not want to watch the screen.

## License

MIT
