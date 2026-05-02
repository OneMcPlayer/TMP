import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLocalDiagnosticPayload,
  buildLocalDiagnosticUrl,
  recordLocalDiagnosticBreadcrumb,
  redactLocalDiagnosticText,
  setLocalDiagnosticContext,
} from './local-diagnostics';

test('redactLocalDiagnosticText removes keys, transcripts, and script text fields', () => {
  const redacted = redactLocalDiagnosticText(
    'Authorization: Bearer sk-secret | transcript=Quante cose | text=Your line is hidden | line=12',
  );

  assert.equal(
    redacted,
    'Authorization: Bearer [redacted] | transcript=[redacted]| text=[redacted]| line=12',
  );
});

test('buildLocalDiagnosticUrl targets session diagnostics when session exists', () => {
  assert.equal(
    buildLocalDiagnosticUrl({
      backendBaseUrl: 'https://example.test',
      sessionId: 'session 1',
    }),
    'https://example.test/api/realtime-webrtc/sessions/session%201/diagnostics',
  );
  assert.equal(
    buildLocalDiagnosticUrl({
      backendBaseUrl: 'https://example.test',
      sessionId: null,
    }),
    'https://example.test/api/realtime-webrtc/diagnostics',
  );
  assert.equal(buildLocalDiagnosticUrl({ backendBaseUrl: '' }), null);
});

test('buildLocalDiagnosticPayload includes sanitized context and breadcrumbs', () => {
  setLocalDiagnosticContext({
    backendBaseUrl: 'https://example.test',
    callId: 'call-1',
    mode: 'tap-rehearsal',
    sessionId: 'session-1',
  });
  recordLocalDiagnosticBreadcrumb('Uploaded User Audio Transcribed', 'transcript=secret line');

  const payload = buildLocalDiagnosticPayload({
    error: new Error('text=private line'),
    extras: {
      expectedText: 'text=private',
      lineNumber: 10,
    },
    type: 'test-error',
  });

  assert.equal(payload.context.sessionId, 'session-1');
  assert.equal(
    payload.breadcrumbs[payload.breadcrumbs.length - 1].details,
    'transcript=[redacted]',
  );
  assert.equal(payload.error?.message, 'text=[redacted]');
  assert.equal(payload.extras?.expectedText, 'text=[redacted]');
  assert.equal(payload.extras?.lineNumber, 10);
});
