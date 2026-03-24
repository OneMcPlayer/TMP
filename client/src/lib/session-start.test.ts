import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSessionTransition } from './session-start';

test('startSessionTransition updates the UI state before priming audio', async () => {
  const steps: string[] = [];
  let resolvePrime: (() => void) | null = null;

  const pendingPrime = new Promise<void>((resolve) => {
    resolvePrime = resolve;
  });

  const transitionPromise = startSessionTransition({
    setShowSetup: (showSetup) => {
      steps.push(`setShowSetup:${String(showSetup)}`);
    },
    setHasStarted: (hasStarted) => {
      steps.push(`setHasStarted:${String(hasStarted)}`);
    },
    setCurrentLineIndex: (index) => {
      steps.push(`setCurrentLineIndex:${String(index)}`);
    },
    primeAudioPlayback: () => {
      steps.push('primeAudioPlayback:start');
      return pendingPrime.then(() => {
        steps.push('primeAudioPlayback:done');
      });
    },
    processFirstLine: () => {
      steps.push('processFirstLine');
    },
  });

  await Promise.resolve();

  assert.deepEqual(steps, [
    'setShowSetup:false',
    'setHasStarted:true',
    'setCurrentLineIndex:0',
    'primeAudioPlayback:start',
  ]);

  resolvePrime?.();
  await transitionPromise;

  assert.deepEqual(steps, [
    'setShowSetup:false',
    'setHasStarted:true',
    'setCurrentLineIndex:0',
    'primeAudioPlayback:start',
    'primeAudioPlayback:done',
    'processFirstLine',
  ]);
});

test('startSessionTransition continues even when priming fails', async () => {
  let processCalls = 0;

  await startSessionTransition({
    setShowSetup: () => undefined,
    setHasStarted: () => undefined,
    setCurrentLineIndex: () => undefined,
    primeAudioPlayback: async () => {
      throw new Error('Playback blocked');
    },
    processFirstLine: () => {
      processCalls += 1;
    },
  });

  assert.equal(processCalls, 1);
});
