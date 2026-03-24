import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRecordingTransition } from './recording-start';

test('startRecordingTransition starts recording before priming audio', async () => {
  const steps: string[] = [];

  await startRecordingTransition({
    startRecording: async () => {
      steps.push('startRecording');
    },
    primeAudioPlayback: async () => {
      steps.push('primeAudioPlayback');
    },
  });

  assert.deepEqual(steps, ['startRecording', 'primeAudioPlayback']);
});

test('startRecordingTransition ignores primeAudioPlayback failures after recording starts', async () => {
  let started = false;

  await startRecordingTransition({
    startRecording: async () => {
      started = true;
    },
    primeAudioPlayback: async () => {
      throw new Error('Playback blocked');
    },
  });

  assert.equal(started, true);
});
