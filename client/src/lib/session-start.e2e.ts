import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSessionTransition } from './session-start';

test('[e2e] first-screen to second-screen transition does not wait for slow primeAudioPlayback', async () => {
  let isSecondScreenVisible = false;
  let releasePrime: () => void = () => undefined;

  const delayedPrime = new Promise<void>((resolve) => {
    releasePrime = resolve;
  });

  const transitionPromise = startSessionTransition({
    setShowSetup: (showSetup) => {
      isSecondScreenVisible = !showSetup;
    },
    setHasStarted: () => undefined,
    setCurrentLineIndex: () => undefined,
    primeAudioPlayback: () => delayedPrime,
    processFirstLine: () => undefined,
  });

  await Promise.resolve();
  assert.equal(isSecondScreenVisible, true);

  releasePrime();
  await transitionPromise;
});
