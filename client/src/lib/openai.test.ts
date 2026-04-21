import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  __resetPlaybackPrimingForTests,
  playAudioBlob,
  playRecordingStartCue,
  primeAudioPlayback,
} from './openai';

type MockAudioMode = 'resolve' | 'reject' | 'pending';

class MockAudio {
  static instances: MockAudio[] = [];
  static mode: MockAudioMode = 'resolve';

  public src: string;
  public preload = '';
  public muted = false;
  public currentTime = 5;
  public onended: (() => void) | null = null;
  public onerror: ((error?: unknown) => void) | null = null;
  public playCalls = 0;
  private attributes = new Map<string, string>();

  constructor(src = '') {
    this.src = src;
    MockAudio.instances.push(this);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  load(): void {
    // no-op in tests
  }

  play(): Promise<void> {
    this.playCalls += 1;

    if (MockAudio.mode === 'reject') {
      return Promise.reject(new DOMException('Playback blocked', 'NotAllowedError'));
    }

    if (MockAudio.mode === 'pending') {
      return new Promise(() => undefined);
    }

    queueMicrotask(() => {
      this.onended?.();
    });

    return Promise.resolve();
  }

  pause(): void {
    // no-op in tests
  }
}

const originalAudio = globalThis.Audio;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  MockAudio.instances = [];
  MockAudio.mode = 'resolve';
  __resetPlaybackPrimingForTests();

  globalThis.Audio = MockAudio as unknown as typeof Audio;
  URL.createObjectURL = (() => 'blob:mock') as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
});

afterEach(() => {
  globalThis.Audio = originalAudio;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  __resetPlaybackPrimingForTests();
});

test('primeAudioPlayback succeeds and memoizes playback priming', async () => {
  await primeAudioPlayback();
  await primeAudioPlayback();

  assert.equal(MockAudio.instances.length, 1);
  const primingAudio = MockAudio.instances[0];
  assert.equal(primingAudio.preload, 'auto');
  assert.equal(primingAudio.getAttribute('playsinline'), '');
  assert.equal(primingAudio.getAttribute('webkit-playsinline'), '');
  assert.equal(primingAudio.currentTime, 0);
});

test('primeAudioPlayback rejects when playback is blocked', async () => {
  MockAudio.mode = 'reject';

  await assert.rejects(() => primeAudioPlayback(), (error: unknown) => {
    assert.ok(error instanceof DOMException);
    assert.equal(error.name, 'NotAllowedError');
    return true;
  });

  assert.equal(MockAudio.instances.length, 1);
});

test('primeAudioPlayback rejects when priming hangs past the timeout', async () => {
  MockAudio.mode = 'pending';

  await assert.rejects(() => primeAudioPlayback(10), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Audio playback priming timed out after 10ms');
    return true;
  });

  await assert.rejects(() => primeAudioPlayback(10));
  assert.equal(MockAudio.instances.length, 1);
  assert.equal(MockAudio.instances[0].playCalls, 2);
});

test('playAudioBlob sets inline playback attributes and resolves', async () => {
  await playAudioBlob(new Blob(['audio']));

  assert.equal(MockAudio.instances.length, 1);
  const playbackAudio = MockAudio.instances[0];
  assert.equal(playbackAudio.src, 'blob:mock');
  assert.equal(playbackAudio.preload, 'auto');
  assert.equal(playbackAudio.getAttribute('playsinline'), '');
  assert.equal(playbackAudio.getAttribute('webkit-playsinline'), '');
});

test('playAudioBlob reuses the primed audio element', async () => {
  await primeAudioPlayback();
  await playAudioBlob(new Blob(['audio']));

  assert.equal(MockAudio.instances.length, 1);
  assert.equal(MockAudio.instances[0].playCalls, 2);
});

test('playAudioBlob aborts cleanly when playback is interrupted', async () => {
  MockAudio.mode = 'pending';
  const abortController = new AbortController();
  const playbackPromise = playAudioBlob(new Blob(['audio']), {
    signal: abortController.signal,
  });

  abortController.abort();

  await assert.rejects(() => playbackPromise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'AbortError');
    return true;
  });

  assert.equal(MockAudio.instances.length, 1);
  assert.equal(MockAudio.instances[0].currentTime, 0);
});

test('playAudioBlob clears priming so a user gesture can re-prime after autoplay is blocked', async () => {
  await primeAudioPlayback();

  MockAudio.mode = 'reject';
  await assert.rejects(() => playAudioBlob(new Blob(['audio'])), (error: unknown) => {
    assert.ok(error instanceof DOMException);
    assert.equal(error.name, 'NotAllowedError');
    return true;
  });

  MockAudio.mode = 'resolve';
  await primeAudioPlayback();

  assert.equal(MockAudio.instances.length, 1);
  assert.equal(MockAudio.instances[0].playCalls, 3);
});

test('playRecordingStartCue reuses the primed audio element for the short recording beep', async () => {
  await primeAudioPlayback();
  await playRecordingStartCue();

  assert.equal(MockAudio.instances.length, 1);
  assert.equal(MockAudio.instances[0].playCalls, 2);
  assert.match(MockAudio.instances[0].src, /^data:audio\/wav;base64,/);
});
