# Known Findings So Far

## Confirmed patterns from real-device testing

- Playback reliability improved after moving to shared audio playback and caching correction audio.
- Service worker, versioning, and asset caching have been healthy; they are not the main blocker.
- iPhone standalone PWA mode still shows unstable behavior around microphone capture and playback-to-recording transitions.
- `navigator.audioSession.type = "playback"` can block later microphone capture on iPhone.
- Car mode has repeatedly produced empty recordings even when recording start and stop appear to succeed.
- With CarPlay enabled on March 29, 2026, `nexttrack` and `previoustrack` did reach the PWA reliably in standalone mode.
- In that same CarPlay run, `play`, `pause`, and `stop` never fired, so next/back are the only controls we should currently trust.
- The metadata-only media probe was enough to receive next/back events; a silent loop was not required just to expose those controls.
- Real-device recording can still produce a tiny first blob before a second take succeeds, so first-take warm-up remains a real issue.

## Working assumptions

- The remaining failures are mostly platform-behavior questions, not simple application bugs.
- We should prefer experiments that isolate one capability at a time over adding more complexity to the rehearsal flow.
- Exportable test reports are more valuable right now than one more hidden heuristic.

## Current open questions

- Does a metadata-only `mediaSession` ever surface working next/back events in the car?
- Do transport events only appear when continuous audio is actively playing?
- Does a persistent warm microphone stream help in standalone mode, or does it only make routing more fragile?
- Which audio session type produces the least harmful tradeoff between playback audibility and microphone capture?
- Are failures different between standalone PWA, Safari tab, lock screen, and connected car audio routes?

## How to use new evidence

When a device run produces new behavior:

1. Save the exported report from the Audio Lab page.
2. Save the date, exact app version, and environment details.
3. Add the new confirmed behavior to this file or to a dated note in this folder.
4. Only then decide whether the main rehearsal app should adopt a new behavior.

That keeps the repo focused on learning what is possible before we move the logic into the fuller server-backed product.
