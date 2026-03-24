import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getPreferredAudioMimeType } from './use-audio-recorder';

test('getPreferredAudioMimeType prefers opus webm when available', () => {
  const mediaRecorder = {
    isTypeSupported: (mimeType: string) => mimeType === 'audio/webm;codecs=opus',
  };

  assert.equal(getPreferredAudioMimeType(mediaRecorder), 'audio/webm;codecs=opus');
});

test('getPreferredAudioMimeType falls back to undefined when no candidates are supported', () => {
  const mediaRecorder = {
    isTypeSupported: () => false,
  };

  assert.equal(getPreferredAudioMimeType(mediaRecorder), undefined);
});
