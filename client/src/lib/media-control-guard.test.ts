import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldIgnoreDuplicateMediaControlAction } from './media-control-guard';

test('shouldIgnoreDuplicateMediaControlAction ignores rapid repeats of the same action', () => {
  assert.equal(
    shouldIgnoreDuplicateMediaControlAction({
      debounceMs: 900,
      lastAction: 'nexttrack',
      lastTimestamp: 1000,
      nextAction: 'nexttrack',
      now: 1500,
    }),
    true,
  );
});

test('shouldIgnoreDuplicateMediaControlAction allows the same action after the debounce window', () => {
  assert.equal(
    shouldIgnoreDuplicateMediaControlAction({
      debounceMs: 900,
      lastAction: 'nexttrack',
      lastTimestamp: 1000,
      nextAction: 'nexttrack',
      now: 2100,
    }),
    false,
  );
});

test('shouldIgnoreDuplicateMediaControlAction allows a different action immediately', () => {
  assert.equal(
    shouldIgnoreDuplicateMediaControlAction({
      debounceMs: 900,
      lastAction: 'nexttrack',
      lastTimestamp: 1000,
      nextAction: 'previoustrack',
      now: 1100,
    }),
    false,
  );
});

test('shouldIgnoreDuplicateMediaControlAction allows the same action after the app scope changes', () => {
  assert.equal(
    shouldIgnoreDuplicateMediaControlAction({
      debounceMs: 900,
      lastAction: 'nexttrack',
      lastScope: '0:waiting-for-user',
      lastTimestamp: 1000,
      nextAction: 'nexttrack',
      nextScope: '0:showing-feedback',
      now: 1100,
    }),
    false,
  );
});
