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
- A later March 29, 2026 visual check showed that the standalone iPhone shell can still make the Audio Lab header feel cramped even when browser-based mobile tests pass, so phone-specific safe-area and shell chrome need to be treated as a separate concern from ordinary responsive layout.
- A separate March 29, 2026 Expo Go native run on an iPhone 13 mini with iOS 18.7.2 produced a strong contrast with the PWA: native playback worked, cold recording worked, and playback-to-recording handoff also worked with usable recordings, which strongly suggests Safari/PWA is the main source of those failures rather than the product logic alone.
- That same Expo Go run also showed `setActiveForLockScreen` was undefined in Expo Go 54.0.6 on-device, so lock-screen transport testing should currently be treated as unsupported in Expo Go even though native playback and recording themselves are promising.
- A later March 29, 2026 Expo Go `1.1.3` run on the same iPhone also showed that the more automatic native flow worked: the app could auto-play a lead-in cue, switch into `play-and-record`, start recording, play a short start beep, and still capture a usable recording afterward.
- That `1.1.3` native run produced usable recordings for every core path we tested: cold recording, playback-to-recording handoff, and the more automated cue-plus-beep flow.
- Taken together, those native runs strongly suggest the biggest remaining blocker is no longer the general rehearsal logic. It is the Safari standalone PWA audio stack and its media-session / play-and-record behavior.
- While testing the fuller Expo Go native prototype, teardown-time `pause()` calls could crash with `NativeSharedObjectNotFoundException`, which suggests Expo Go can invalidate audio-player shared objects before React cleanup finishes. Cleanup in the experiment now guards against that.
- On April 14, 2026, the repo gained a separate browser-plus-backend Realtime WebRTC spike (`#/realtime-lab` plus `experiments/realtime-webrtc-lab/server.ts`) so we can test a true call-shaped architecture instead of repeating the older delayed playback chain.
- On April 17, 2026, a real iPhone Safari browser-tab run of that Realtime WebRTC spike reached the strongest web result we have seen so far: the browser connected, ICE completed, the data channel opened, remote audio attached and played, server-side VAD detected speech, and the backend sideband log showed full response lifecycles.
- That same April 17, 2026 run also exposed a concrete protocol bug in our experiment code rather than a platform blocker: both the browser client and backend sideband session were still sending `response.modalities`, and OpenAI Realtime returned `invalid_request_error: Unknown parameter: 'response.modalities'.`
- Despite that invalid parameter error, the session still produced real assistant audio and transcript deltas after speech was detected, which strongly suggests the backend-assisted browser-call architecture is viable enough to keep pursuing.
- The exported April 17, 2026 report came from Safari in browser-tab mode, not standalone PWA mode, and the page was not under an active service worker at the time. That means this result proves the architecture in ordinary mobile Safari first; standalone-PWA reliability still needs to be tested separately.
- The same report also showed a later `Backend Log Poll Failed — Load failed` event after report export, which looks more like a transient fetch/polling issue during or after the session than a call-establishment failure.
- On April 24, 2026, the repo gained a separate `#/tap-rehearsal` prototype that keeps the script cursor and correction policy on the backend, hides normal user lines, disables automatic VAD commits, and lets the user tap once when their line is complete.

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
- If we rerun the same playback and recording tests in Expo Go with native `expo-audio`, does the native stack remove the Safari-only autoplay and playback-to-recording failures enough to justify moving the fuller app off the PWA path?
- If Expo Go already fixes the key playback and recording failures, is the next native experiment better framed as an EAS development build focused on lock-screen and transport-control behavior rather than more Expo Go wizard work?
- If Expo Go playback and recording are already stable, does a more automatic native flow of cue playback followed by auto-start recording and a recording-start beep still remain usable in practice?
- If the auto cue + auto record + beep native flow is already viable in Expo Go, how close can we get to a full rehearsal loop before needing a server-backed app or a development build?
- Does the new native car-flow prototype remain usable across multiple lines, retries, and automatic correction playback, or does it need a thinner first version?
- Does a backend-assisted browser WebRTC call on iPhone Safari keep remote audio and local microphone more reliably alive than the static PWA request / response architecture?
- If that browser-call spike behaves better, is the next step a minimal server-backed rehearsal prototype rather than one more attempt to force the static PWA path into call-like behavior?
- Once the obsolete `response.modalities` parameter is removed, does the same iPhone Safari browser-call flow remain stable without protocol errors across repeated prompts and longer conversations?
- After the browser-tab success on April 17, 2026, how much of that same behavior survives when the exact same backend-assisted call flow is retried in standalone PWA mode?
- Does the `#/tap-rehearsal` manual-commit flow produce cleaner user-line boundaries than server VAD while still keeping the microphone and playback reliable on iPhone Safari and standalone PWA?

## How to use new evidence

When a device run produces new behavior:

1. Save the exported report from the Audio Lab page.
2. Save the date, exact app version, and environment details.
3. Add the new confirmed behavior to this file or to a dated note in this folder.
4. Only then decide whether the main rehearsal app should adopt a new behavior.

That keeps the repo focused on learning what is possible before we move the logic into the fuller server-backed product.
