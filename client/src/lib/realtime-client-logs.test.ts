import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_REALTIME_CLIENT_LOG_BATCH_SIZE,
  buildRealtimeClientDiagnosticsLogsUrl,
  buildRealtimeClientLogsUrl,
  buildRealtimeSessionLogsUrl,
  buildRealtimeSessionsUrl,
  postRealtimeClientLogs,
} from './realtime-client-logs';

test('buildRealtimeClientLogsUrl targets the session client log endpoint', () => {
  assert.equal(
    buildRealtimeClientLogsUrl('http://127.0.0.1:8787', 'session 1'),
    'http://127.0.0.1:8787/api/realtime-webrtc/sessions/session%201/client-logs',
  );
  assert.equal(
    buildRealtimeClientDiagnosticsLogsUrl('http://127.0.0.1:8787'),
    'http://127.0.0.1:8787/api/realtime-webrtc/client-logs',
  );
});

test('session helper URLs support recovering backend logs without client state', () => {
  assert.equal(
    buildRealtimeSessionsUrl('https://backend.example'),
    'https://backend.example/api/realtime-webrtc/sessions',
  );
  assert.equal(
    buildRealtimeSessionLogsUrl('https://backend.example', 'session 1'),
    'https://backend.example/api/realtime-webrtc/sessions/session%201/logs',
  );
});

test('postRealtimeClientLogs skips empty or inactive sessions', async () => {
  const accepted = await postRealtimeClientLogs({
    backendBaseUrl: null,
    entries: [{ event: 'Opened', timestamp: '2026-04-24T00:00:00.000Z' }],
    fetcher: (() => {
      throw new Error('fetch should not be called');
    }) as typeof fetch,
    sessionId: 'session-1',
    source: 'test',
  });

  assert.equal(accepted, 0);
});

test('postRealtimeClientLogs sends diagnostic logs before a session exists', async () => {
  let capturedRequest: { body?: string; url?: string } = {};

  const accepted = await postRealtimeClientLogs({
    backendBaseUrl: 'http://127.0.0.1:8787',
    entries: [{ event: 'Backend Health Check Started', timestamp: '2026-04-24T00:00:00.000Z' }],
    fetcher: (async (input, init) => {
      capturedRequest = {
        body: String(init?.body),
        url: String(input),
      };
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
    }) as typeof fetch,
    sessionId: null,
    source: 'tap-rehearsal',
  });

  assert.equal(accepted, 1);
  assert.equal(
    capturedRequest.url,
    'http://127.0.0.1:8787/api/realtime-webrtc/client-logs',
  );
});

test('postRealtimeClientLogs sends a capped batch to the backend', async () => {
  const entries = Array.from({ length: MAX_REALTIME_CLIENT_LOG_BATCH_SIZE + 2 }, (_, index) => ({
    event: `event-${index}`,
    timestamp: '2026-04-24T00:00:00.000Z',
  }));
  let capturedRequest: { body?: string; url?: string } = {};

  const accepted = await postRealtimeClientLogs({
    backendBaseUrl: 'http://127.0.0.1:8787',
    entries,
    fetcher: (async (input, init) => {
      capturedRequest = {
        body: String(init?.body),
        url: String(input),
      };
      return new Response(JSON.stringify({ accepted: MAX_REALTIME_CLIENT_LOG_BATCH_SIZE }), {
        status: 200,
      });
    }) as typeof fetch,
    sessionId: 'session-1',
    source: 'tap-rehearsal',
  });

  assert.equal(accepted, MAX_REALTIME_CLIENT_LOG_BATCH_SIZE);
  assert.equal(
    capturedRequest.url,
    'http://127.0.0.1:8787/api/realtime-webrtc/sessions/session-1/client-logs',
  );

  const payload = JSON.parse(capturedRequest.body ?? '{}') as {
    entries?: unknown[];
    source?: string;
  };
  assert.equal(payload.source, 'tap-rehearsal');
  assert.equal(payload.entries?.length, MAX_REALTIME_CLIENT_LOG_BATCH_SIZE);
});
