import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClientDiagnosticRecord,
  redactLocalDiagnosticText,
  summarizeClientDiagnosticRecord,
} from './local-diagnostics';

test('redactLocalDiagnosticText removes sensitive text patterns', () => {
  assert.equal(
    redactLocalDiagnosticText('Authorization: Bearer sk-secret | transcript=secret | text=line'),
    'Authorization: Bearer [redacted] | transcript=[redacted]| text=[redacted]',
  );
});

test('buildClientDiagnosticRecord sanitizes payloads', () => {
  const record = buildClientDiagnosticRecord(
    {
      breadcrumbs: [
        {
          details: 'expectedText=secret line',
          event: 'Correction',
          timestamp: '2026-04-27T10:00:00.000Z',
        },
      ],
      browser: {
        online: true,
        userAgent: 'Browser',
        nested: { ignored: true },
      },
      context: {
        route: 'tap-rehearsal',
        sessionId: 'session-1',
      },
      error: {
        message: 'spokenText=hidden',
        name: 'TypeError',
        stack: 'text=hidden',
      },
      extras: {
        objectValue: { ignored: true },
        transcript: 'transcript=private',
      },
      severity: 'warning',
      timestamp: '2026-04-27T10:00:01.000Z',
      type: 'window-error',
      version: '1.3.12',
    },
    '2026-04-27T10:00:02.000Z',
  );

  assert.equal(record.severity, 'warning');
  assert.equal(record.breadcrumbs[0].details, 'expectedText=[redacted]');
  assert.equal(record.error?.message, 'spokenText=[redacted]');
  assert.equal(record.error?.stack, 'text=[redacted]');
  assert.equal(record.extras.transcript, 'transcript=[redacted]');
  assert.equal('objectValue' in record.extras, false);
  assert.equal(record.browser?.online, true);
  assert.equal('nested' in (record.browser ?? {}), false);
});

test('summarizeClientDiagnosticRecord gives compact log details', () => {
  const record = buildClientDiagnosticRecord({
    breadcrumbs: [{ event: 'Started', timestamp: '2026-04-27T10:00:00.000Z' }],
    context: { route: 'tap-rehearsal', status: 'connected' },
    error: { message: 'failed', name: 'Error' },
    severity: 'error',
    type: 'test-error',
    version: '1.3.12',
  });

  assert.equal(
    summarizeClientDiagnosticRecord(record),
    'type=test-error | severity=error | version=1.3.12 | route=tap-rehearsal | status=connected | error=Error: failed | breadcrumbs=1',
  );
});
