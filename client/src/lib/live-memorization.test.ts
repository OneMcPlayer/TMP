import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLiveMemorizationContinuePrompt,
  buildLiveMemorizationGreetingPrompt,
  buildLiveMemorizationInstructions,
  buildLiveMemorizationPreviewLines,
  buildLiveMemorizationRepeatPrompt,
  buildLiveMemorizationRevealPrompt,
  clampLiveMemorizationAttempts,
  clampLiveMemorizationStartLine,
} from './live-memorization';
import type { Script } from './types';

const SCRIPT: Script = {
  title: 'Memorization Test',
  author: 'Codex',
  language: 'it',
  lines: [
    { character: 'ALICE', text: 'Partner opening. (looks away)' },
    { character: 'BOB', text: 'My cue line.' },
    { character: 'ALICE', text: 'Partner closing.' },
  ],
};

test('clampLiveMemorizationStartLine keeps the value inside the script bounds', () => {
  assert.equal(clampLiveMemorizationStartLine(0, 3), 1);
  assert.equal(clampLiveMemorizationStartLine(2, 3), 2);
  assert.equal(clampLiveMemorizationStartLine(99, 3), 3);
});

test('clampLiveMemorizationAttempts keeps attempts in the supported range', () => {
  assert.equal(clampLiveMemorizationAttempts(0), 1);
  assert.equal(clampLiveMemorizationAttempts(3), 3);
  assert.equal(clampLiveMemorizationAttempts(8), 5);
});

test('buildLiveMemorizationInstructions marks user and partner lines and strips stage directions', () => {
  const instructions = buildLiveMemorizationInstructions({
    maxAttemptsPerLine: 3,
    script: SCRIPT,
    selectedCharacter: 'BOB',
    startLineNumber: 1,
  });

  assert.match(instructions, /The human performer is rehearsing the role BOB/);
  assert.match(instructions, /1\. \[PARTNER\] ALICE: Partner opening\./);
  assert.match(instructions, /2\. \[USER\] BOB: My cue line\./);
  assert.doesNotMatch(instructions, /looks away/);
});

test('buildLiveMemorizationGreetingPrompt opens from the chosen line', () => {
  const greetingPrompt = buildLiveMemorizationGreetingPrompt({
    maxAttemptsPerLine: 2,
    script: SCRIPT,
    selectedCharacter: 'BOB',
    startLineNumber: 2,
  });

  assert.match(greetingPrompt, /line 2/);
  assert.match(greetingPrompt, /rehearsing BOB/);
});

test('buildLiveMemorizationPreviewLines returns a focused script window', () => {
  const previewLines = buildLiveMemorizationPreviewLines(
    {
      maxAttemptsPerLine: 3,
      script: SCRIPT,
      selectedCharacter: 'BOB',
      startLineNumber: 2,
    },
    2,
  );

  assert.deepEqual(previewLines, [
    '2. [USER] BOB: My cue line.',
    '3. [PARTNER] ALICE: Partner closing.',
  ]);
});

test('live memorization helper prompts stay short and action-oriented', () => {
  assert.match(buildLiveMemorizationRepeatPrompt(), /Repeat the current scripted cue once/);
  assert.match(buildLiveMemorizationContinuePrompt(), /Continue the memorization session/);
  assert.match(buildLiveMemorizationRevealPrompt(), /Reveal only my next expected line once/);
});
