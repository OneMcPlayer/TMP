import assert from 'node:assert/strict';
import { test } from 'node:test';

import { calculateAudioLevel, isSilentAudioLevel } from './silence-detection';

test('calculateAudioLevel returns RMS and handles empty input', () => {
  assert.equal(calculateAudioLevel(new Float32Array()), 0);

  const samples = new Float32Array([0.1, -0.1, 0.1, -0.1]);
  const level = calculateAudioLevel(samples);

  assert.ok(level > 0.09 && level < 0.11);
});

test('isSilentAudioLevel evaluates the silence threshold for auto-stop', () => {
  assert.equal(isSilentAudioLevel(0), true);
  assert.equal(isSilentAudioLevel(0.009), true);
  assert.equal(isSilentAudioLevel(0.01), false);
  assert.equal(isSilentAudioLevel(0.05), false);
});
