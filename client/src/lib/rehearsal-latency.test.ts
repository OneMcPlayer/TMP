import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSlowPreparation,
  PREPARATION_RECOVERY_THRESHOLD_MS,
  shouldOfferPreparationRecovery,
  SLOW_PREPARATION_THRESHOLD_MS,
} from './rehearsal-latency';

test('isSlowPreparation flips true at the 10-second threshold', () => {
  assert.equal(isSlowPreparation(SLOW_PREPARATION_THRESHOLD_MS - 1), false);
  assert.equal(isSlowPreparation(SLOW_PREPARATION_THRESHOLD_MS), true);
  assert.equal(isSlowPreparation(SLOW_PREPARATION_THRESHOLD_MS + 5_000), true);
});

test('shouldOfferPreparationRecovery flips true at the 30-second threshold', () => {
  assert.equal(shouldOfferPreparationRecovery(PREPARATION_RECOVERY_THRESHOLD_MS - 1), false);
  assert.equal(shouldOfferPreparationRecovery(PREPARATION_RECOVERY_THRESHOLD_MS), true);
  assert.equal(shouldOfferPreparationRecovery(PREPARATION_RECOVERY_THRESHOLD_MS + 5_000), true);
});
