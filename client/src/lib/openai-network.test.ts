import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  __resetPlaybackPrimingForTests,
  getAudioUploadFilename,
  speechToText,
  textToSpeech,
} from './openai';

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;
const originalCaches = globalThis.caches;

function resolveRequestKey(request: RequestInfo | URL): string {
  if (request instanceof Request) {
    return request.url;
  }

  if (request instanceof URL) {
    return request.toString();
  }

  return String(request);
}

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

function createCacheStorageMock(): CacheStorage {
  const cacheStores = new Map<string, Map<string, Response>>();

  return {
    async delete(cacheName: string) {
      return cacheStores.delete(cacheName);
    },
    async has(cacheName: string) {
      return cacheStores.has(cacheName);
    },
    async keys() {
      return Array.from(cacheStores.keys());
    },
    async match(request: RequestInfo | URL) {
      const requestKey = resolveRequestKey(request);

      for (const store of cacheStores.values()) {
        const response = store.get(requestKey);
        if (response) {
          return response.clone();
        }
      }

      return undefined;
    },
    async open(cacheName: string) {
      if (!cacheStores.has(cacheName)) {
        cacheStores.set(cacheName, new Map());
      }

      const store = cacheStores.get(cacheName)!;
      return {
        add: async () => undefined,
        addAll: async () => undefined,
        async delete(request: RequestInfo | URL) {
          return store.delete(resolveRequestKey(request));
        },
        async keys() {
          return [];
        },
        async match(request: RequestInfo | URL) {
          const response = store.get(resolveRequestKey(request));
          return response?.clone();
        },
        async matchAll(request?: RequestInfo | URL) {
          if (!request) {
            return Array.from(store.values(), (response) => response.clone());
          }

          const response = store.get(resolveRequestKey(request));
          return response ? [response.clone()] : [];
        },
        async put(request: RequestInfo | URL, response: Response) {
          store.set(resolveRequestKey(request), response.clone());
        },
      } as unknown as Cache;
    },
  } as CacheStorage;
}

beforeEach(() => {
  __resetPlaybackPrimingForTests();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: createStorageMock(),
  });
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: createCacheStorageMock(),
  });
  localStorage.setItem('openrouter_api_key', 'test-key');
});

afterEach(() => {
  __resetPlaybackPrimingForTests();
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: originalLocalStorage,
  });
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: originalCaches,
  });
});

test('textToSpeech sends OpenRouter speech requests with OpenRouter auth and model', async () => {
  let capturedRequest: RequestInfo | URL | null = null;
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (request, init) => {
    capturedRequest = request;
    capturedInit = init;
    return new Response(new Blob(['openrouter-audio']), { status: 200 });
  }) as typeof fetch;

  const audio = await textToSpeech('ciao', { voice: 'alloy' });

  assert.equal(String(capturedRequest), 'https://openrouter.ai/api/v1/audio/speech');
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get('Authorization'), 'Bearer test-key');
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(headers.get('X-OpenRouter-Title'), 'Finale di partita Rehearsal Partner');

  const body = JSON.parse(String(capturedInit?.body));
  assert.deepEqual(body, {
    model: 'openai/tts-1',
    input: 'ciao',
    voice: 'alloy',
    response_format: 'mp3',
  });
  assert.equal(await audio.text(), 'openrouter-audio');
});

test('speechToText sends OpenRouter transcription requests as base64 JSON', async () => {
  let capturedRequest: RequestInfo | URL | null = null;
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (request, init) => {
    capturedRequest = request;
    capturedInit = init;
    return new Response(JSON.stringify({ text: 'hello world' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const result = await speechToText(new Blob(['voice-data'], { type: 'audio/webm;codecs=opus' }));

  assert.equal(result, 'hello world');
  assert.equal(String(capturedRequest), 'https://openrouter.ai/api/v1/audio/transcriptions');
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get('Authorization'), 'Bearer test-key');
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(headers.get('X-OpenRouter-Title'), 'Finale di partita Rehearsal Partner');

  const body = JSON.parse(String(capturedInit?.body));
  assert.equal(body.model, 'openai/whisper-large-v3');
  assert.deepEqual(body.input_audio, {
    data: Buffer.from('voice-data').toString('base64'),
    format: 'webm',
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

test('textToSpeech stores generated audio locally and reuses it on the next call', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(new Blob(['cached-audio']), { status: 200 });
  }) as typeof fetch;

  const firstAudio = await textToSpeech('ciao');
  const secondAudio = await textToSpeech('ciao');

  assert.equal(calls, 1);
  assert.equal(await firstAudio.text(), 'cached-audio');
  assert.equal(await secondAudio.text(), 'cached-audio');
});

test('textToSpeech deduplicates in-flight requests for the same text and voice', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(new Blob(['shared-audio']), { status: 200 });
  }) as typeof fetch;

  const [firstAudio, secondAudio] = await Promise.all([
    textToSpeech('same line', { voice: 'fable' }),
    textToSpeech('same line', { voice: 'fable' }),
  ]);

  assert.equal(calls, 1);
  assert.equal(await firstAudio.text(), 'shared-audio');
  assert.equal(await secondAudio.text(), 'shared-audio');
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
