import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRecordingTransition } from './recording-start';

test('[e2e] first record tap prioritizes microphone start before playback priming', async () => {
  const timeline: string[] = [];
  let releasePrime: () => void = () => undefined;

  const transitionPromise = startRecordingTransition({
    startRecording: async () => {
      timeline.push('recording-started');
      return true;
    },
    primeAudioPlayback: () =>
      new Promise<void>((resolve) => {
        timeline.push('prime-pending');
        releasePrime = () => {
          timeline.push('prime-finished');
          resolve();
        };
      }),
  });

  await Promise.resolve();
  assert.deepEqual(timeline, ['recording-started', 'prime-pending']);

  releasePrime();
  await transitionPromise;
  assert.deepEqual(timeline, ['recording-started', 'prime-pending', 'prime-finished']);
});
