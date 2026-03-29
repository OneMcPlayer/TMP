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

Important limitations:

- This Expo Go build does not currently expose the same next/back track callback path the web Audio Lab was testing with CarPlay, so this native experiment focuses on playback, recording, and lock-screen play/pause instead.
- On the March 29, 2026 iPhone 13 mini / iOS 18.7.2 run, native playback, cold recording, and playback-to-recording handoff all succeeded, but `setActiveForLockScreen` was undefined inside Expo Go 54.0.6, so lock-screen controls should currently be treated as unsupported in Expo Go itself.
- The new `auto cue + beep` step is specifically meant to answer whether a more hands-free native flow can work: auto-play a lead-in, auto-start recording, and play a second beep right after recording begins so the user knows when to speak.

## How to run

```bash
cd expo-go-audio-lab
npm start
```

Then open the project in Expo Go on the phone.

## What to export

At the end of the wizard:

- copy the report
- or share the report as a text file

Bring that report back to the main repo experiment so we can compare:

- Safari standalone PWA
- Expo Go native audio

## Version

This experiment is currently aligned to repo version `1.1.3`.
