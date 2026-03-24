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

## Quality Checks

Run the full local validation suite (typecheck + unit tests + e2e tests + production build):

```bash
npm run test:full
```

You can also run checks individually with `npm run check`, `npm test`, `npm run test:e2e`, and `npm run build`.

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
