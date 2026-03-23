import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appendDebugLogEntry, createDebugLogEntry } from './debug-log';
import { buildTranscriptionPrompt, getSpeakableText, normalizeScript } from './script-utils';
import { calculateAccuracy, computeWordDiff } from './word-diff';

test('e2e rehearsal flow normalizes script, builds prompt, and scores transcription robustly', () => {
  const script = normalizeScript({
    title: '  Finale di partita  ',
    author: '  Samuel Beckett  ',
    language: '  Italian  ',
    lines: [
      {
        speaker: '  Hamm  ',
        line: 'Andiamo. (Pausa.) Non possiamo.',
      },
      {
        character: 'CLOV',
        text: 'Perché?'
      }
    ],
  });

  assert.equal(script.title, 'Finale di partita');
  assert.equal(script.author, 'Samuel Beckett');
  assert.equal(script.language, 'Italian');
  assert.deepEqual(script.lines, [
    { character: 'Hamm', text: 'Andiamo. (Pausa.) Non possiamo.' },
    { character: 'CLOV', text: 'Perché?' },
  ]);

  const speakableText = getSpeakableText(script.lines[0].text);
  assert.equal(speakableText, 'Andiamo. Non possiamo.');

  const prompt = buildTranscriptionPrompt(script, 'Hamm', speakableText);
  assert.match(prompt, /This is Italian theatrical dialogue from "Finale di partita"\./);
  assert.match(prompt, /Author: Samuel Beckett\./);
  assert.match(prompt, /Language: Italian\./);
  assert.match(prompt, /The user is rehearsing as Hamm\./);
  assert.match(prompt, /Character names may include: Hamm, CLOV\./);
  assert.match(prompt, /Expected line context: Andiamo\. Non possiamo\./);

  const spokenText = 'andiamo non possiaMo!';
  const diff = computeWordDiff(speakableText, spokenText);

  assert.deepEqual(diff, [
    { word: 'andiamo', status: 'correct' },
    { word: 'non', status: 'correct' },
    { word: 'possiamo', status: 'correct' },
  ]);
  assert.equal(calculateAccuracy(diff), 100);

  const withMistake = computeWordDiff(speakableText, 'andiamo possiamo');
  assert.equal(calculateAccuracy(withMistake), 67);

  const debugTrail = appendDebugLogEntry(
    appendDebugLogEntry([], createDebugLogEntry('Script Loaded', 'Loaded script.json successfully', '2026-03-23T09:00:00Z')),
    createDebugLogEntry('Line Scored', `Accuracy: ${calculateAccuracy(withMistake)}%`, '2026-03-23T09:00:05Z'),
  );

  assert.equal(debugTrail.length, 2);
  assert.equal(debugTrail[1].details, 'Accuracy: 67%');
});

test('e2e rehearsal flow strips nested stage directions before scoring', () => {
  const expected = 'Io resto qui (con calma (quasi immobile)) ad aspettare.';
  const spoken = 'io resto qui ad aspettare';

  const diff = computeWordDiff(expected, spoken);

  assert.deepEqual(diff, [
    { word: 'io', status: 'correct' },
    { word: 'resto', status: 'correct' },
    { word: 'qui', status: 'correct' },
    { word: 'ad', status: 'correct' },
    { word: 'aspettare', status: 'correct' },
  ]);
  assert.equal(calculateAccuracy(diff), 100);
});
