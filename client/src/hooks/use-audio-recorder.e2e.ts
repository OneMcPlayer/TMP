import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getPreferredAudioMimeType } from './use-audio-recorder';

test('e2e mime type negotiation gracefully falls back for browsers without supported types', () => {
  const unsupportedRecorder = {
    isTypeSupported: (_mimeType: string) => false,
  };

  const mimeType = getPreferredAudioMimeType(unsupportedRecorder);
  const recorderInitMode = mimeType ? 'with-options' : 'default-constructor';

  assert.equal(mimeType, undefined);
  assert.equal(recorderInitMode, 'default-constructor');
});
