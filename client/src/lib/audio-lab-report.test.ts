import test from 'node:test';
import assert from 'node:assert/strict';

import { serializeAudioLabReport, type AudioLabReport } from './audio-lab-report';

test('serializeAudioLabReport includes the main sections and counters', () => {
  const report: AudioLabReport = {
    appVersion: '1.0.28',
    exportedAt: '2026-03-29T12:00:00.000Z',
    locationHref: 'https://example.com/#/audio-lab',
    testerNotes: 'Next track never fired in the car.',
    audioSession: {
      supported: true,
      type: 'play-and-record',
      state: 'active',
      history: ['type=play-and-record', 'state=active'],
    },
    mediaControls: {
      probeMode: 'silent-loop',
      counts: {
        play: 1,
        pause: 0,
        stop: 0,
        nexttrack: 0,
        previoustrack: 0,
        seekforward: 0,
        seekbackward: 0,
      },
    },
    microphone: {
      permissionSummary: 'Permission granted.',
      warmStreamSummary: 'Warm stream active with 1 live track.',
    },
    recording: {
      mode: 'car',
      summary: 'Recording succeeded.',
      lastBlobSize: 1234,
      lastMimeType: 'audio/webm',
    },
    steps: {
      environment: {
        status: 'success',
        summary: 'Snapshot captured.',
      },
      mediaControls: {
        status: 'warning',
        summary: 'No hardware events received yet.',
      },
    },
    debugEntries: [
      {
        timestamp: '2026-03-29T12:00:00.000Z',
        event: 'Media Control Triggered',
        details: 'action=play | count=1',
      },
    ],
  };

  const serialized = serializeAudioLabReport(report);

  assert.match(serialized, /Audio Lab Report/);
  assert.match(serialized, /Probe mode: silent-loop/);
  assert.match(serialized, /Next track: 0/);
  assert.match(serialized, /environment: SUCCESS — Snapshot captured\./);
  assert.match(serialized, /Tester Notes/);
  assert.match(serialized, /Media Control Triggered/);
});
