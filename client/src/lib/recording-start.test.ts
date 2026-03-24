import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRecordingTransition } from './recording-start';

test('startRecordingTransition starts recording before priming audio', async () => {
  const steps: string[] = [];
  let resolvePrime: () => void = () => undefined;

  const transitionPromise = startRecordingTransition({
    startRecording: async () => {
      steps.push('startRecording');
    },
    primeAudioPlayback: () =>
      new Promise<void>((resolve) => {
        steps.push('primeAudioPlayback');
        resolvePrime = resolve;
      }),
  });

  await Promise.resolve();
  assert.deepEqual(steps, ['startRecording', 'primeAudioPlayback']);

  resolvePrime();
  await transitionPromise;
});

test('startRecordingTransition ignores primeAudioPlayback failures after recording starts', async () => {
  let started = false;
  const errors: string[] = [];

  await startRecordingTransition({
    startRecording: async () => {
      started = true;
    },
    primeAudioPlayback: async () => {
      throw new Error('Playback blocked');
    },
    onPrimeAudioPlaybackError: (error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  });

  assert.equal(started, true);
  await Promise.resolve();
  assert.deepEqual(errors, ['Playback blocked']);
});
