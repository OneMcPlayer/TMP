import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDebugLogEntry } from './debug-log';
import {
  normalizeRealtimeCallLabBackendUrl,
  serializeRealtimeCallLabReport,
  summarizeRealtimeEvent,
} from './realtime-call-lab';

test('normalizeRealtimeCallLabBackendUrl trims and normalizes valid HTTP(S) URLs', () => {
  assert.equal(
    normalizeRealtimeCallLabBackendUrl(' https://example.com:8787/path?query=yes#hash '),
    'https://example.com:8787/path',
  );
  assert.equal(
    normalizeRealtimeCallLabBackendUrl('http://127.0.0.1:8787/'),
    'http://127.0.0.1:8787',
  );
});

test('normalizeRealtimeCallLabBackendUrl rejects invalid or unsupported URLs', () => {
  assert.equal(normalizeRealtimeCallLabBackendUrl(''), null);
  assert.equal(normalizeRealtimeCallLabBackendUrl('ws://example.com'), null);
  assert.equal(normalizeRealtimeCallLabBackendUrl('not-a-url'), null);
});

test('summarizeRealtimeEvent extracts the most useful debugging fields', () => {
  assert.equal(
    summarizeRealtimeEvent({
      type: 'error',
      event_id: 'evt_123',
      error: { type: 'server_error', message: 'Something broke' },
    }),
    'type=error | event=evt_123 | errorType=server_error | error=Something broke',
  );
});

test('serializeRealtimeCallLabReport combines local and backend logs into one export', () => {
  const report = serializeRealtimeCallLabReport({
    version: '1.1.7',
    exportedAt: '2026-04-14T18:00:00Z',
    backendBaseUrl: 'https://example.com',
    sessionId: 'session-123',
    callId: 'rtc_123',
    status: 'connected',
    connectionState: 'connected',
    iceConnectionState: 'connected',
    iceGatheringState: 'complete',
    signalingState: 'stable',
    dataChannelState: 'open',
    remoteAudioAttached: true,
    remoteAudioPlaying: true,
    notes: 'Worked once.',
    localLogs: [createDebugLogEntry('Start', 'One tap', '2026-04-14T18:00:01Z')],
    serverLogs: [
      {
        seq: 1,
        timestamp: '2026-04-14T18:00:02Z',
        level: 'info',
        event: 'Sideband Connected',
        details: 'callId=rtc_123',
      },
    ],
  });

  assert.match(report, /Realtime Browser Call Lab Report/);
  assert.match(report, /Backend: https:\/\/example.com/);
  assert.match(report, /Remote audio playing: yes/);
  assert.match(report, /\[2026-04-14T18:00:01Z\] Start — One tap/);
  assert.match(report, /\[2026-04-14T18:00:02Z\] INFO Sideband Connected — callId=rtc_123/);
});
