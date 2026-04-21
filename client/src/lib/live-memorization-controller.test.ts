import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLiveMemorizationController,
  consumeNextAutomaticSpeech,
  getCurrentLiveMemorizationLine,
  getUpcomingUserLine,
  processLiveMemorizationTranscript,
} from '@shared/live-memorization-controller';
import type { Script } from '@shared/rehearsal-core';

const SCRIPT: Script = {
  title: 'Controller Test',
  author: 'Codex',
  language: 'it',
  lines: [
    { character: 'ALICE', text: 'Partner opening. (looks away)' },
    { character: 'BOB', text: 'My cue line.' },
    { character: 'ALICE', text: 'Partner closing.' },
    { character: 'BOB', text: 'Second user line.' },
  ],
};

test('controller consumes partner lines and exposes the next user line', () => {
  const controller = buildLiveMemorizationController({
    maxAttemptsPerLine: 3,
    script: SCRIPT,
    selectedCharacter: 'BOB',
    startLineNumber: 1,
  });

  const partnerLine = consumeNextAutomaticSpeech(controller);

  assert.equal(partnerLine?.lineNumber, 1);
  assert.equal(partnerLine?.speakableText, 'Partner opening.');
  assert.equal(getCurrentLiveMemorizationLine(controller)?.lineNumber, 2);
  assert.equal(getUpcomingUserLine(controller)?.lineNumber, 2);
});

test('accepted user transcript advances to the next scripted beat', () => {
  const controller = buildLiveMemorizationController({
    maxAttemptsPerLine: 3,
    script: SCRIPT,
    selectedCharacter: 'BOB',
    startLineNumber: 2,
  });

  const outcome = processLiveMemorizationTranscript(controller, 'My cue line');

  assert.equal(outcome.type, 'accepted');
  assert.equal(outcome.evaluation.accepted, true);
  assert.equal(getCurrentLiveMemorizationLine(controller)?.lineNumber, 3);
});

test('failed attempts eventually reveal and advance when the limit is reached', () => {
  const controller = buildLiveMemorizationController({
    maxAttemptsPerLine: 2,
    script: SCRIPT,
    selectedCharacter: 'BOB',
    startLineNumber: 2,
  });

  const firstAttempt = processLiveMemorizationTranscript(controller, 'Completely wrong');
  const secondAttempt = processLiveMemorizationTranscript(controller, 'Still wrong');

  assert.equal(firstAttempt.type, 'retry');
  assert.equal(firstAttempt.attemptsRemaining, 1);
  assert.equal(secondAttempt.type, 'reveal-and-advance');
  assert.equal(secondAttempt.revealText, 'My cue line.');
  assert.equal(getCurrentLiveMemorizationLine(controller)?.lineNumber, 3);
});

test('voice control commands are detected and can advance the cursor', () => {
  const controller = buildLiveMemorizationController({
    maxAttemptsPerLine: 3,
    script: SCRIPT,
    selectedCharacter: 'BOB',
    startLineNumber: 2,
  });

  const revealOutcome = processLiveMemorizationTranscript(controller, 'line please');
  const skipOutcome = processLiveMemorizationTranscript(controller, 'skip');

  assert.equal(revealOutcome.type, 'control');
  assert.equal(revealOutcome.command, 'reveal');
  assert.equal(skipOutcome.type, 'control');
  assert.equal(skipOutcome.command, 'skip');
  assert.equal(getCurrentLiveMemorizationLine(controller)?.lineNumber, 3);
});
