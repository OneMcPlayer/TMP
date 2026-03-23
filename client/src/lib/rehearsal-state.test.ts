import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildRehearsalLines,
  buildSkippedUserLine,
  needsRehearsalLineInitialization,
} from './rehearsal-flow';
import type { Script } from './types';

const script: Script = {
  title: 'Finale di partita',
  author: 'Samuel Beckett',
  language: 'Italian',
  lines: [
    { character: 'HAMM', text: 'Andiamo.' },
    { character: 'CLOV', text: 'Non posso.' },
  ],
};

test('buildRehearsalLines maps script lines and selected character correctly', () => {
  const lines = buildRehearsalLines(script, 'CLOV');

  assert.deepEqual(lines, [
    {
      index: 0,
      character: 'HAMM',
      text: 'Andiamo.',
      isUserLine: false,
      state: 'pending',
    },
    {
      index: 1,
      character: 'CLOV',
      text: 'Non posso.',
      isUserLine: true,
      state: 'pending',
    },
  ]);
});

test('needsRehearsalLineInitialization detects missing or stale lines', () => {
  const freshLines = buildRehearsalLines(script, 'CLOV');
  assert.equal(needsRehearsalLineInitialization(freshLines, script, 'CLOV'), false);

  assert.equal(needsRehearsalLineInitialization([], script, 'CLOV'), true);

  const staleCharacterLines = buildRehearsalLines(script, 'HAMM');
  assert.equal(needsRehearsalLineInitialization(staleCharacterLines, script, 'CLOV'), true);

  const mutatedLines = [...freshLines];
  mutatedLines[1] = { ...mutatedLines[1], text: 'Non posso più.' };
  assert.equal(needsRehearsalLineInitialization(mutatedLines, script, 'CLOV'), true);
});

test('buildSkippedUserLine marks a user line as completed with skipped metadata', () => {
  const lines = buildRehearsalLines(script, 'HAMM');
  const skippedLine = buildSkippedUserLine(lines[0]);

  assert.equal(skippedLine.state, 'completed');
  assert.equal(skippedLine.spokenText, '');
  assert.deepEqual(skippedLine.diff, []);
  assert.equal(skippedLine.accuracy, 0);
  assert.equal(skippedLine.correctionPlayed, false);
});
