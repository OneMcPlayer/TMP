import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prepareDeviceForRehearsal } from './device-setup';

test('prepareDeviceForRehearsal kicks off playback priming before microphone preparation settles', async () => {
  const steps: string[] = [];
  let resolveMicrophone: () => void = () => undefined;

  const preparationPromise = prepareDeviceForRehearsal({
    primeAudioPlayback: async () => {
      steps.push('playback-started');
    },
    prepareMicrophone: () =>
      new Promise<void>((resolve) => {
        steps.push('microphone-started');
        resolveMicrophone = () => {
          steps.push('microphone-ready');
          resolve();
        };
      }),
    onPlaybackReady: () => {
      steps.push('playback-ready');
    },
    onMicrophoneReady: () => {
      steps.push('microphone-callback');
    },
  });

  await Promise.resolve();
  assert.deepEqual(steps, [
    'playback-started',
    'microphone-started',
    'playback-ready',
  ]);

  resolveMicrophone();
  const result = await preparationPromise;

  assert.deepEqual(result, {
    playbackReady: true,
    microphoneReady: true,
  });
  assert.deepEqual(steps, [
    'playback-started',
    'microphone-started',
    'playback-ready',
    'microphone-ready',
    'microphone-callback',
  ]);
});

test('prepareDeviceForRehearsal reports partial failures without aborting the other step', async () => {
  const errors: string[] = [];
  const readySteps: string[] = [];

  const result = await prepareDeviceForRehearsal({
    primeAudioPlayback: async () => {
      throw new Error('Playback blocked');
    },
    prepareMicrophone: async () => {
      readySteps.push('microphone-ready');
    },
    onPlaybackError: (error) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
    onMicrophoneReady: () => {
      readySteps.push('microphone-callback');
    },
  });

  assert.deepEqual(result, {
    playbackReady: false,
    microphoneReady: true,
  });
  assert.deepEqual(errors, ['Playback blocked']);
  assert.deepEqual(readySteps, ['microphone-ready', 'microphone-callback']);
});
