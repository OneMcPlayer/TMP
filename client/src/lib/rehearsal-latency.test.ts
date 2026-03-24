import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSlowPreparation, SLOW_PREPARATION_THRESHOLD_MS } from './rehearsal-latency';

test('isSlowPreparation flips true at the 10-second threshold', () => {
  assert.equal(isSlowPreparation(SLOW_PREPARATION_THRESHOLD_MS - 1), false);
  assert.equal(isSlowPreparation(SLOW_PREPARATION_THRESHOLD_MS), true);
  assert.equal(isSlowPreparation(SLOW_PREPARATION_THRESHOLD_MS + 5_000), true);
});
