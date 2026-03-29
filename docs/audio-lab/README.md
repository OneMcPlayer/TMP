# Audio Lab

This repo now doubles as an iPhone PWA audio experiment.

The goal is not just to keep patching rehearsal mode blindly. It is to learn, on real devices, what Safari standalone mode actually allows for:

- playback priming
- audible cues
- `navigator.audioSession`
- microphone permission
- persistent warm microphone streams
- manual recording
- media-session transport controls such as `play`, `nexttrack`, and `previoustrack`

## Why this exists

The main rehearsal app has already gone through several rounds of playback, recording, and car-mode fixes. The remaining issues appear to be platform limits or platform-specific behavior, not just ordinary bugs. This lab page gives us a repeatable way to test those behaviors directly.

## How to open it

From the launch screen in the app, use `Open Audio Lab`.

You can also open it directly with the hash route:

- `#/audio-lab`

The app uses a hash route on purpose so it still works under GitHub Pages and standalone PWA mode.

## What to test

The page walks through six areas:

1. Environment snapshot
2. Playback
3. Audio session modes
4. Microphone permission and warm-stream behavior
5. Recording
6. Media controls

At the end, add device notes and export a report as text or JSON.

## What to save

When running a real-device session, try to keep:

- device model
- iOS version
- browser or standalone PWA mode
- app version
- whether headphones, Bluetooth, or car audio were connected
- exported Audio Lab report
- any screenshots or screen recordings

## What this page intentionally does not assume

- It does not assume autoplay success means audible output was actually heard.
- It does not assume media-session handlers fire just because the page set them.
- It does not assume a successful recording start means non-empty audio was captured.

Those are exactly the assumptions the lab is trying to verify.
