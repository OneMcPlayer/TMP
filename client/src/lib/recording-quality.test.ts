import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSuspiciouslySmallRecordingBlob,
  MIN_VALID_RECORDING_BLOB_BYTES,
} from './recording-quality';

test('isSuspiciouslySmallRecordingBlob ignores empty blobs because they are handled separately', () => {
  assert.equal(isSuspiciouslySmallRecordingBlob(0), false);
});

test('isSuspiciouslySmallRecordingBlob flags tiny warm-up blobs', () => {
  assert.equal(isSuspiciouslySmallRecordingBlob(5), true);
  assert.equal(isSuspiciouslySmallRecordingBlob(MIN_VALID_RECORDING_BLOB_BYTES - 1), true);
});

test('isSuspiciouslySmallRecordingBlob allows normally sized recordings', () => {
  assert.equal(isSuspiciouslySmallRecordingBlob(MIN_VALID_RECORDING_BLOB_BYTES), false);
  assert.equal(isSuspiciouslySmallRecordingBlob(99863), false);
});
