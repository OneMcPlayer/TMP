import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  __resetPlaybackPrimingForTests,
  playAudioBlob,
  primeAudioPlayback,
} from './openai';

type MockAudioMode = 'resolve' | 'reject';

class MockAudio {
  static instances: MockAudio[] = [];
  static mode: MockAudioMode = 'resolve';

  public src: string;
  public preload = '';
  public muted = false;
  public currentTime = 5;
  public onended: (() => void) | null = null;
  public onerror: ((error?: unknown) => void) | null = null;
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

  play(): Promise<void> {
    if (MockAudio.mode === 'reject') {
      return Promise.reject(new DOMException('Playback blocked', 'NotAllowedError'));
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

test('playAudioBlob sets inline playback attributes and resolves', async () => {
  await playAudioBlob(new Blob(['audio']));

  assert.equal(MockAudio.instances.length, 1);
  const playbackAudio = MockAudio.instances[0];
  assert.equal(playbackAudio.src, 'blob:mock');
  assert.equal(playbackAudio.preload, 'auto');
  assert.equal(playbackAudio.getAttribute('playsinline'), '');
});
