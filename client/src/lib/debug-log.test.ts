import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendDebugLogEntry,
  createDebugLogEntry,
  serializeDebugLogEntries,
} from './debug-log';

test('createDebugLogEntry keeps provided values', () => {
  const entry = createDebugLogEntry('Transcription Error', 'Network timeout', '2026-03-23T12:00:00Z');

  assert.equal(entry.timestamp, '2026-03-23T12:00:00Z');
  assert.equal(entry.event, 'Transcription Error');
  assert.equal(entry.details, 'Network timeout');
});

test('appendDebugLogEntry keeps only the newest entries when max is reached', () => {
  const first = createDebugLogEntry('First', undefined, '2026-03-23T10:00:00Z');
  const second = createDebugLogEntry('Second', undefined, '2026-03-23T10:00:01Z');
  const third = createDebugLogEntry('Third', undefined, '2026-03-23T10:00:02Z');

  const entries = appendDebugLogEntry(
    appendDebugLogEntry(appendDebugLogEntry([], first, 2), second, 2),
    third,
    2,
  );

  assert.equal(entries.length, 2);
  assert.equal(entries[0].event, 'Second');
  assert.equal(entries[1].event, 'Third');
});

test('serializeDebugLogEntries builds a ready-to-paste text log', () => {
  const text = serializeDebugLogEntries([
    createDebugLogEntry('Session Started', undefined, '2026-03-23T11:00:00Z'),
    createDebugLogEntry('Line Scored', 'Accuracy: 92%', '2026-03-23T11:00:10Z'),
  ]);

  assert.equal(
    text,
    [
      '[2026-03-23T11:00:00Z] Session Started',
      '[2026-03-23T11:00:10Z] Line Scored — Accuracy: 92%',
    ].join('\n'),
  );
});
