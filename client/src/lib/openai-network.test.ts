import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { getAudioUploadFilename, speechToText, textToSpeech } from './openai';

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;

function createStorageMock(): Storage {
  const data = new Map<string, string>();

  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, String(value));
    },
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: createStorageMock(),
  });
  localStorage.setItem('openai_api_key', 'test-key');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: originalLocalStorage,
  });
});

test('textToSpeech retries once when first response is transient server error', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('temporary issue', { status: 503 });
    }

    return new Response(new Blob(['ok-audio']), { status: 200 });
  }) as typeof fetch;

  const audio = await textToSpeech('ciao');

  assert.equal(calls, 2);
  assert.equal(await audio.text(), 'ok-audio');
});

test('speechToText retries once on network error', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      throw new TypeError('network down');
    }

    return new Response(JSON.stringify({ text: 'hello world' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const result = await speechToText(new Blob(['voice-data']));

  assert.equal(calls, 2);
  assert.equal(result, 'hello world');
});

test('getAudioUploadFilename matches the blob mime type', () => {
  assert.equal(
    getAudioUploadFilename(new Blob(['voice-data'], { type: 'audio/mp4' })),
    'recording.mp4',
  );
  assert.equal(
    getAudioUploadFilename(new Blob(['voice-data'], { type: 'audio/webm;codecs=opus' })),
    'recording.webm',
  );
  assert.equal(
    getAudioUploadFilename(new Blob(['voice-data'], { type: 'audio/wav' })),
    'recording.wav',
  );
});
