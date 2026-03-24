import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSlowPreparation, shouldOfferPreparationRecovery } from './rehearsal-latency';

test('[e2e] slow-preparation messaging appears only after ten seconds elapsed', () => {
  const timelineMs = [1_000, 5_000, 9_999, 10_000, 15_000];
  const states = timelineMs.map((elapsedMs) => isSlowPreparation(elapsedMs));

  assert.deepEqual(states, [false, false, false, true, true]);
});

test('[e2e] recovery action appears only after thirty seconds elapsed', () => {
  const timelineMs = [10_000, 20_000, 29_999, 30_000, 45_000];
  const states = timelineMs.map((elapsedMs) => shouldOfferPreparationRecovery(elapsedMs));

  assert.deepEqual(states, [false, false, false, true, true]);
});
