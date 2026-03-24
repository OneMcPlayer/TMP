import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appendDebugLogEntry, createDebugLogEntry } from './debug-log';
import { buildRehearsalLines, buildSkippedUserLine, needsRehearsalLineInitialization } from './rehearsal-flow';
import { buildTranscriptionPrompt, getSpeakableText, normalizeScript } from './script-utils';
import type { Script } from './types';
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

test('buildRehearsalLines marks user lines and initializes every line as pending', () => {
  const script: Script = {
    title: 'Finale',
    lines: [
      { character: 'Hamm', text: 'Parla' },
      { character: 'Clov', text: 'Rispondi' },
      { character: 'Hamm', text: 'Ancora' },
    ],
  };

  const result = buildRehearsalLines(script, 'Hamm');

  assert.deepEqual(result, [
    { index: 0, character: 'Hamm', text: 'Parla', isUserLine: true, state: 'pending' },
    { index: 1, character: 'Clov', text: 'Rispondi', isUserLine: false, state: 'pending' },
    { index: 2, character: 'Hamm', text: 'Ancora', isUserLine: true, state: 'pending' },
  ]);
});

test('needsRehearsalLineInitialization only returns true when script mapping is stale', () => {
  const script: Script = {
    title: 'Finale',
    lines: [
      { character: 'Hamm', text: 'Parla' },
      { character: 'Clov', text: 'Rispondi' },
    ],
  };

  const freshLines = buildRehearsalLines(script, 'Hamm');
  assert.equal(needsRehearsalLineInitialization(freshLines, script, 'Hamm'), false);

  const staleCharacterSelection = buildRehearsalLines(script, 'Clov');
  assert.equal(needsRehearsalLineInitialization(staleCharacterSelection, script, 'Hamm'), true);

  const staleText = [
    freshLines[0],
    { ...freshLines[1], text: 'Nuovo testo' },
  ];
  assert.equal(needsRehearsalLineInitialization(staleText, script, 'Hamm'), true);

  assert.equal(needsRehearsalLineInitialization(freshLines.slice(0, 1), script, 'Hamm'), true);
});

test('buildSkippedUserLine keeps identity fields while forcing deterministic skipped result', () => {
  const skipped = buildSkippedUserLine({
    index: 4,
    character: 'Hamm',
    text: 'Io non posso continuare.',
    isUserLine: true,
    state: 'active',
    spokenText: 'prova',
    accuracy: 40,
    correctionPlayed: true,
    diff: [{ word: 'io', status: 'extra' }],
  });

  assert.deepEqual(skipped, {
    index: 4,
    character: 'Hamm',
    text: 'Io non posso continuare.',
    isUserLine: true,
    state: 'completed',
    spokenText: '',
    diff: [],
    accuracy: 0,
    correctionPlayed: false,
  });
});
