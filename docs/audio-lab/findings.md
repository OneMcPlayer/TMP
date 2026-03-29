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
- A later March 29, 2026 comparison suggested the main rehearsal car mode was not exposing itself to CarPlay the same way as the Audio Lab probe, even though the probe itself worked.
- Because of that, the main app now keeps `mediaSession.playbackState = "playing"` while an active car-mode session is on screen and logs incoming media-control events directly in the rehearsal debug log.
- Another March 29, 2026 Audio Lab run suggested next/back events were easier to trigger only after other explicit interactions such as probe arming, playback, or recording steps, which points to session arming order as part of the problem.
- The main car-mode flow now tries to imitate that pattern by arming the media session earlier and playing a short cue at session start.
- A later March 29, 2026 `1.0.32` run still showed that Audio Lab could eventually receive next/back events while the main rehearsal car mode did not, so the lab remains the more trustworthy source of capability evidence.
- That same `1.0.32` run also showed that the short playback cue can time out even after silent playback priming succeeds, which means cue reliability is another variable worth tracking explicitly.
- Real-device recordings are better than they were earlier in the week, but blob sizes in the low-kilobyte range can still land in a gray area where the capture technically succeeded but may not represent a genuinely useful spoken take.

## Working assumptions

- The remaining failures are mostly platform-behavior questions, not simple application bugs.
- We should prefer experiments that isolate one capability at a time over adding more complexity to the rehearsal flow.
- Exportable test reports are more valuable right now than one more hidden heuristic.
- When the lab and the main rehearsal app disagree, prefer trusting the lab result first and then make the main app imitate the lab’s successful session shape.

## Current open questions

- Does a metadata-only `mediaSession` ever surface working next/back events in the car before any other explicit audio action?
- Which exact step is most likely to wake controls up on the phone: metadata-only probe, silent loop, playback cue, audio-session change, or recording?
- Do transport events only appear when continuous audio is actively playing?
- Does a persistent warm microphone stream help in standalone mode, or does it only make routing more fragile?
- Which audio session type produces the least harmful tradeoff between playback audibility and microphone capture?
- What blob-size threshold is the most useful line between a warm-up artifact and a genuinely usable short take?
- Are failures different between standalone PWA, Safari tab, lock screen, and connected car audio routes?
- After the latest main-app arming change, do `Media Control Triggered` entries now appear in the regular rehearsal debug log during real CarPlay use?
- Does the short cue at car-mode session start make the first next/back press work more reliably in the main app?
- How often does the short cue itself time out after priming, and does that correlate with later media-control failures?

## How to use new evidence

When a device run produces new behavior:

1. Save the exported report from the Audio Lab page.
2. Save the date, exact app version, and environment details.
3. Add the new confirmed behavior to this file or to a dated note in this folder.
4. Only then decide whether the main rehearsal app should adopt a new behavior.

That keeps the repo focused on learning what is possible before we move the logic into the fuller server-backed product.
