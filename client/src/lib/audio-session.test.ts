import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getAudioSession,
  resolvePreferredAudioSessionType,
  setPreferredAudioSessionType,
  subscribeToAudioSessionState,
  type NavigatorWithAudioSession,
} from './audio-session';

test('resolvePreferredAudioSessionType stays auto until rehearsal audio is armed', () => {
  assert.equal(
    resolvePreferredAudioSessionType({
      carMode: false,
      hasCompletedDeviceSetup: false,
      hasStarted: false,
      isPreparingDevice: false,
      isRecording: false,
    }),
    'auto',
  );
});

test('resolvePreferredAudioSessionType prefers playback during setup before rehearsal starts', () => {
  assert.equal(
    resolvePreferredAudioSessionType({
      carMode: false,
      hasCompletedDeviceSetup: true,
      hasStarted: false,
      isPreparingDevice: false,
      isRecording: false,
    }),
    'playback',
  );
});

test('resolvePreferredAudioSessionType returns auto during a normal rehearsal so recording can arm later', () => {
  assert.equal(
    resolvePreferredAudioSessionType({
      carMode: false,
      hasCompletedDeviceSetup: true,
      hasStarted: true,
      isPreparingDevice: false,
      isRecording: false,
    }),
    'auto',
  );
});

test('resolvePreferredAudioSessionType prefers play-and-record when car mode or recording is active', () => {
  assert.equal(
    resolvePreferredAudioSessionType({
      carMode: true,
      hasCompletedDeviceSetup: true,
      hasStarted: true,
      isPreparingDevice: false,
      isRecording: false,
    }),
    'play-and-record',
  );
  assert.equal(
    resolvePreferredAudioSessionType({
      carMode: false,
      hasCompletedDeviceSetup: false,
      hasStarted: true,
      isPreparingDevice: false,
      isRecording: true,
    }),
    'play-and-record',
  );
});

test('setPreferredAudioSessionType updates supported sessions and reports the current state', () => {
  const navigatorLike = {
    audioSession: {
      state: 'active',
      type: 'auto',
    },
  } as NavigatorWithAudioSession;

  assert.deepEqual(setPreferredAudioSessionType(navigatorLike, 'playback'), {
    supported: true,
    changed: true,
    state: 'active',
  });
  assert.equal(navigatorLike.audioSession?.type, 'playback');
});

test('getAudioSession and subscribeToAudioSessionState gracefully handle unsupported browsers', () => {
  assert.equal(getAudioSession(undefined), null);

  let callbackCount = 0;
  const unsubscribe = subscribeToAudioSessionState(undefined, () => {
    callbackCount += 1;
  });

  unsubscribe();
  assert.equal(callbackCount, 0);
});

test('subscribeToAudioSessionState forwards statechange events', () => {
  class FakeAudioSession extends EventTarget {
    public state = 'active';
    public type = 'auto';
  }

  const audioSession = new FakeAudioSession();
  const navigatorLike = { audioSession } as NavigatorWithAudioSession;
  const seenStates: string[] = [];

  const unsubscribe = subscribeToAudioSessionState(navigatorLike, (state) => {
    seenStates.push(state);
  });

  audioSession.state = 'interrupted';
  audioSession.dispatchEvent(new Event('statechange'));
  unsubscribe();
  audioSession.state = 'active';
  audioSession.dispatchEvent(new Event('statechange'));

  assert.deepEqual(seenStates, ['interrupted']);
});
