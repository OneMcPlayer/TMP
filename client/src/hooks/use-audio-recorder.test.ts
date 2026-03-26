import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRecordingAudioConstraints,
  getPreferredAudioMimeType,
  getRecordingCaptureError,
  hasLiveAudioTracks,
  NO_AUDIO_CAPTURED_ERROR,
  NO_SPEECH_DETECTED_ERROR,
  prepareMicrophoneAccess,
  preparePersistentMicrophoneAccess,
} from './use-audio-recorder';

test('buildRecordingAudioConstraints keeps the default cleanup settings', () => {
  assert.deepEqual(buildRecordingAudioConstraints(), {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });
});

test('buildRecordingAudioConstraints adds mono capture in car mode', () => {
  assert.deepEqual(buildRecordingAudioConstraints(true), {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  });
});

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

test('prepareMicrophoneAccess warms microphone permission and stops the temporary tracks', async () => {
  let requestedConstraints: MediaStreamConstraints | null = null;
  let stopCalls = 0;

  await prepareMicrophoneAccess(
    {
      getUserMedia: async (constraints) => {
        requestedConstraints = constraints;

        return {
          getTracks: () => [
            {
              stop: () => {
                stopCalls += 1;
              },
            },
          ],
        } as MediaStream;
      },
    },
    true,
  );

  assert.deepEqual(requestedConstraints, {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  assert.equal(stopCalls, 1);
});

test('preparePersistentMicrophoneAccess returns the live stream without stopping it', async () => {
  let stopCalls = 0;
  const stream = {
    getTracks: () => [
      {
        readyState: 'live',
        stop: () => {
          stopCalls += 1;
        },
      },
    ],
  } as unknown as MediaStream;

  const preparedStream = await preparePersistentMicrophoneAccess(
    {
      getUserMedia: async () => stream,
    },
    true,
  );

  assert.equal(preparedStream, stream);
  assert.equal(stopCalls, 0);
});

test('hasLiveAudioTracks only reports usable streams with non-ended tracks', () => {
  assert.equal(hasLiveAudioTracks(null), false);
  assert.equal(
    hasLiveAudioTracks({
      getTracks: () => [{ readyState: 'ended' }],
    } as unknown as MediaStream),
    false,
  );
  assert.equal(
    hasLiveAudioTracks({
      getTracks: () => [{ readyState: 'live' }],
    } as unknown as MediaStream),
    true,
  );
  assert.equal(
    hasLiveAudioTracks({
      getTracks: () => [{}],
    } as unknown as MediaStream),
    true,
  );
});

test('prepareMicrophoneAccess reports unsupported browsers clearly', async () => {
  await assert.rejects(
    prepareMicrophoneAccess(undefined),
    /does not support microphone access/,
  );
});
