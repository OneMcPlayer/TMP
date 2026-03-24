import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getPreferredAudioMimeType,
  getRecordingCaptureError,
  NO_AUDIO_CAPTURED_ERROR,
  NO_SPEECH_DETECTED_ERROR,
} from './use-audio-recorder';

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

test('getRecordingCaptureError reports no speech when silence auto-stop ends an empty take', () => {
  assert.equal(
    getRecordingCaptureError({
      blobSize: 0,
      detectedSpeech: false,
      silenceTriggered: true,
    }),
    NO_SPEECH_DETECTED_ERROR,
  );
});

test('getRecordingCaptureError reports empty audio when recording stops without data', () => {
  assert.equal(
    getRecordingCaptureError({
      blobSize: 0,
      detectedSpeech: true,
      silenceTriggered: false,
    }),
    NO_AUDIO_CAPTURED_ERROR,
  );
});

test('getRecordingCaptureError allows populated recordings through', () => {
  assert.equal(
    getRecordingCaptureError({
      blobSize: 128,
      detectedSpeech: false,
      silenceTriggered: true,
    }),
    null,
  );
});
