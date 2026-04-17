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

## Car Mode Note

This is still a standard web page, so it does **not** have native Apple CarPlay integration or access to CarPlay-specific system UI. The included **car mode** is a browser-side layout and recording mode designed to be easier to use from your phone while connected in the car.

On browsers that expose the Media Session API, car mode also listens for the car's **next track** and **previous track** controls so you can move line-by-line without touching the screen as often.
On browsers that expose the Screen Wake Lock API, car mode also tries to keep the phone screen awake while rehearsal is active. If wake lock is unavailable, keep the phone unlocked and connected to power for the most reliable experience.

## Script Format

The app supports either legacy `character`/`text` lines or `speaker`/`line` lines. The bundled script is already configured for **Finale di partita** in `client/public/script.json`.

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

Local backend:

```bash
export OPENAI_API_KEY=sk-...
npm run realtime-lab:server
```

The backend helper lives in [experiments/realtime-webrtc-lab/README.md](/workspaces/TMP/experiments/realtime-webrtc-lab/README.md). This experiment is intentionally separate from the static GitHub Pages deployment so we can test a backend-assisted call flow without destabilizing the main rehearsal app.

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
