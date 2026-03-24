import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRehearsalLines, buildSkippedUserLine, needsRehearsalLineInitialization } from './rehearsal-flow';
import { normalizeScript } from './script-utils';

test('[e2e] rehearsal lines are rebuilt when selected character changes after setup', () => {
  const script = normalizeScript({
    title: 'Finale di partita',
    lines: [
      { speaker: 'Hamm', line: 'Andiamo.' },
      { speaker: 'Clov', line: 'Non possiamo.' },
      { speaker: 'Hamm', line: 'Perché?' },
    ],
  });

  const initialLines = buildRehearsalLines(script, 'Hamm');
  assert.equal(needsRehearsalLineInitialization(initialLines, script, 'Hamm'), false);

  assert.equal(needsRehearsalLineInitialization(initialLines, script, 'Clov'), true);

  const rebuiltLines = buildRehearsalLines(script, 'Clov');
  assert.deepEqual(
    rebuiltLines.map((line) => ({ index: line.index, isUserLine: line.isUserLine })),
    [
      { index: 0, isUserLine: false },
      { index: 1, isUserLine: true },
      { index: 2, isUserLine: false },
    ],
  );
});

test('[e2e] skip action stores a stable completed user-line snapshot for analytics', () => {
  const script = normalizeScript({
    title: 'Finale di partita',
    lines: [
      { speaker: 'Hamm', line: 'Non finisce mai.' },
      { speaker: 'Clov', line: 'È finita, forse.' },
    ],
  });

  const rehearsalLines = buildRehearsalLines(script, 'Hamm');

  const skippedUserLine = buildSkippedUserLine({
    ...rehearsalLines[0],
    state: 'active',
    spokenText: 'tentativo incompleto',
    diff: [{ word: 'non', status: 'correct' }],
    accuracy: 20,
    correctionPlayed: true,
  });

  assert.equal(skippedUserLine.state, 'completed');
  assert.equal(skippedUserLine.spokenText, '');
  assert.equal(skippedUserLine.accuracy, 0);
  assert.equal(skippedUserLine.correctionPlayed, false);
  assert.deepEqual(skippedUserLine.diff, []);

  assert.equal(skippedUserLine.index, 0);
  assert.equal(skippedUserLine.character, 'Hamm');
  assert.equal(skippedUserLine.text, 'Non finisce mai.');
  assert.equal(skippedUserLine.isUserLine, true);
});
