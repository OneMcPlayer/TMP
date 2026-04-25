import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTapUserTurnKey,
  canOpenTapUserTurn,
  shouldResolveTapCommittedLine,
  shouldStartTapCoachCueGate,
} from './tap-rehearsal-turn';

test('buildTapUserTurnKey tracks clean and correction attempts separately', () => {
  assert.equal(buildTapUserTurnKey(null, null), null);
  assert.equal(buildTapUserTurnKey({ isUserLine: false, lineNumber: 1 }, null), null);
  assert.equal(buildTapUserTurnKey({ isUserLine: true, lineNumber: 2 }, null), '2:clean');
  assert.equal(
    buildTapUserTurnKey(
      { isUserLine: true, lineNumber: 2 },
      { timestamp: '2026-04-25T09:15:20.000Z' },
    ),
    '2:2026-04-25T09:15:20.000Z',
  );
});

test('shouldStartTapCoachCueGate starts once for unopened user turns', () => {
  assert.equal(
    shouldStartTapCoachCueGate({
      completedCoachCueTurnKey: null,
      lastOpenedTurnKey: null,
      pendingCoachCueTurnKey: null,
      turnKey: '2:clean',
    }),
    true,
  );
  assert.equal(
    shouldStartTapCoachCueGate({
      completedCoachCueTurnKey: null,
      lastOpenedTurnKey: '2:clean',
      pendingCoachCueTurnKey: null,
      turnKey: '2:clean',
    }),
    false,
  );
  assert.equal(
    shouldStartTapCoachCueGate({
      completedCoachCueTurnKey: null,
      lastOpenedTurnKey: null,
      pendingCoachCueTurnKey: '2:clean',
      turnKey: '2:clean',
    }),
    false,
  );
  assert.equal(
    shouldStartTapCoachCueGate({
      completedCoachCueTurnKey: '2:clean',
      lastOpenedTurnKey: null,
      pendingCoachCueTurnKey: null,
      turnKey: '2:clean',
    }),
    false,
  );
});

test('canOpenTapUserTurn waits until coach cue speech is complete', () => {
  const readyState = {
    coachAudioPlaying: false,
    currentLine: { isUserLine: true, lineNumber: 2 },
    dataChannelState: 'open',
    isControlStatePending: false,
    isCommittingTurn: false,
    isOpeningTurn: false,
    speechQueueLength: 0,
    status: 'connected',
  };

  assert.equal(
    canOpenTapUserTurn({
      ...readyState,
      isWaitingForCoachCue: true,
    }),
    false,
  );
  assert.equal(
    canOpenTapUserTurn({
      ...readyState,
      isWaitingForCoachCue: false,
    }),
    true,
  );
  assert.equal(
    canOpenTapUserTurn({
      ...readyState,
      isControlStatePending: true,
      isWaitingForCoachCue: false,
    }),
    false,
  );
  assert.equal(
    canOpenTapUserTurn({
      ...readyState,
      coachAudioPlaying: true,
      isWaitingForCoachCue: false,
    }),
    false,
  );
});

test('shouldResolveTapCommittedLine resolves checking after correction or line movement', () => {
  assert.equal(
    shouldResolveTapCommittedLine({
      committedLineNumber: null,
      currentLine: { isUserLine: true, lineNumber: 2 },
      hasCorrection: true,
    }),
    false,
  );
  assert.equal(
    shouldResolveTapCommittedLine({
      committedLineNumber: 2,
      currentLine: { isUserLine: true, lineNumber: 2 },
      hasCorrection: false,
    }),
    false,
  );
  assert.equal(
    shouldResolveTapCommittedLine({
      committedLineNumber: 2,
      currentLine: { isUserLine: true, lineNumber: 2 },
      hasCorrection: true,
    }),
    true,
  );
  assert.equal(
    shouldResolveTapCommittedLine({
      committedLineNumber: 2,
      currentLine: { isUserLine: false, lineNumber: 3 },
      hasCorrection: false,
    }),
    true,
  );
});
