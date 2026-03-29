# Expo Go Native Audio Lab

This folder is a separate React Native / Expo experiment for the same audio questions the web PWA has been testing.

The goal is simple:

- keep the main web app intact
- try the same playback and recording problems with native Expo audio
- learn whether moving off Safari standalone mode removes the biggest blockers

## What this app tests

The current wizard focuses on the native paths most likely to improve over the PWA:

1. Native playback cue
2. Microphone permission
3. Cold recording
4. Playback-to-recording handoff
5. Automatic cue -> auto-record -> recording-start beep
6. Lock-screen play/pause controls
7. Exportable report with detailed logs

The app now also includes a separate `Native Car Flow` prototype that tries a fuller rehearsal loop:

- choose the rehearsal character
- choose the maximum number of retry attempts
- auto-play partner lines with OpenAI TTS
- auto-start recording on the user's lines
- auto-play a short beep right after recording begins
- auto-detect when the user stops speaking
- transcribe and score the take with OpenAI STT
- replay the expected line as a correction when the score is too low
- retry automatically until the score is accepted or the max-attempt limit is reached
- then continue to the next line automatically

Important limitations:

- This Expo Go build does not currently expose the same next/back track callback path the web Audio Lab was testing with CarPlay, so this native experiment focuses on playback, recording, and lock-screen play/pause instead.
- On the March 29, 2026 iPhone 13 mini / iOS 18.7.2 run, native playback, cold recording, and playback-to-recording handoff all succeeded, but `setActiveForLockScreen` was undefined inside Expo Go 54.0.6, so lock-screen controls should currently be treated as unsupported in Expo Go itself.
- The new `auto cue + beep` step is specifically meant to answer whether a more hands-free native flow can work: auto-play a lead-in, auto-start recording, and play a second beep right after recording begins so the user knows when to speak.
- The new `Native Car Flow` prototype uses the current script bundle copied from the web app, but it is still an experiment and currently asks for a pasted OpenAI API key directly inside Expo Go.
- Expo Go can also invalidate native audio player objects during teardown, so cleanup in this experiment needs to treat `pause()` and related shutdown calls defensively.

## How to run

```bash
cd expo-go-audio-lab
npm start
```

Then open the project in Expo Go on the phone.

Inside the app:

1. Run the Audio Lab wizard first if you want a clean capability report.
2. Use `Open Car Prototype` from the lab header to jump into the fuller native rehearsal flow.
3. Export the report from either mode when you finish testing.

## What to export

At the end of the wizard:

- copy the report
- or share the report as a text file

Bring that report back to the main repo experiment so we can compare:

- Safari standalone PWA
- Expo Go native audio
- Expo Go native car-flow prototype

## Version

This experiment is currently aligned to repo version `1.1.5`.
