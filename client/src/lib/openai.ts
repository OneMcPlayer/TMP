import { buildTtsCacheKey, getCachedTtsBlob, setCachedTtsBlob, __resetTtsCacheStateForTests } from './tts-cache';

const API_KEY_STORAGE_KEY = 'openrouter_api_key';
const OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_APP_TITLE = 'Finale di partita Rehearsal Partner';
const TTS_MODEL = 'openai/tts-1';
const STT_MODEL = 'openai/whisper-large-v3';
const TTS_RESPONSE_FORMAT = 'mp3';
const API_REQUEST_TIMEOUT_MS = 15_000;
const MAX_API_RETRY_ATTEMPTS = 1;
const PLAYBACK_PRIMING_TIMEOUT_MS = 1_500;
const RECORDING_START_CUE_TIMEOUT_MS = 750;
// A short silent clip is more reliable on iOS PWAs than an empty WAV header.
const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,' +
  'UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
const RECORDING_START_CUE_DATA_URI =
  'data:audio/wav;base64,' +
  'UklGRiQFAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAFAAAAAIMAkgEaAi4BxP7z' +
  '+3L6nvuM/7QEhgiwCG4EN/1L9jrzFvYy/iUINw+fD3sIjfw18QDs+e/0+8oKkhXTFkoNy/zB7Nvk' +
  'WenX+JoMghs4Hs8S/v0Y6kHg++Qd9sgLChxvH2YUAACa65Hg9uM49OMJBRu/H+gVAgIx7QLhDONg' +
  '8vUH4xnwH1QXAwTb7pHhQOKW8P8FqBgAIKgY/wWW8EDikeHb7gMEVBfwH+MZ9Qdg8gzjAuEx7QIC' +
  '6BW/HwUb4wk49PbjkeCa6wAAZhRvHwocyAsd9vvkQeAY6v79zxL+HvQcoA0L+B3mEOCs6P37JRFv' +
  'HsAdag8B+ljnAOBY5wH6ag/AHW8eJRH9+6zoEOAd5gv4oA30HP4ezxL+/RjqQeD75B32yAsKHG8f' +
  'ZhQAAJrrkeD24zj04wkFG78f6BUCAjHtAuEM42Dy9QfjGfAfVBcDBNvukeFA4pbw/wWoGAAgqBj/' +
  'BZbwQOKR4dvuAwRUF/Af4xn1B2DyDOMC4THtAgLoFb8fBRvjCTj09uOR4JrrAABmFG8fChzICx32' +
  '++RB4Bjq/v3PEv4e9BygDQv4HeYQ4Kzo/fslEW8ewB1qDwH6WOcA4FjnAfpqD8Adbx4lEf37rOgQ' +
  '4B3mC/igDfQc/h7PEv79GOpB4PvkHfbICwocbx9mFAAAmuuR4PbjOPTjCQUbvx/oFQICMe0C4Qzj' +
  'YPL1B+MZ8B9UFwME2+6R4UDilvD/BagYACCoGP8FlvBA4pHh2+4DBFQX8B/jGfUHYPIM4wLhMe0C' +
  'AugVvx8FG+MJOPT245HgmusAAGYUbx8KHMgLHfb75EHgGOr+/c8S/h70HKANC/gd5hDgrOj9+yUR' +
  'bx7AHWoPAfpY5wDgWOcB+moPwB1vHiUR/fus6BDgHeYL+KAN9Bz+Hs8S/v0Y6kHg++Qd9sgLChxv' +
  'H2YUAACa65Hg9uM49OMJBRu/H+gVAgIx7QLhDONg8vUH4xnwH1QXAwTb7pHhQOKW8P8FqBgAIKgY' +
  '/wWW8EDikeHb7gMEVBfwH+MZ9Qdg8gzjAuEx7QIC6BW/HwUb4wk49PbjkeCa6wAAZhRvHwocyAsd' +
  '9vvkQeAY6v79zxL+HvQcoA0L+B3mEOCs6P37JRFvHsAdag8B+ljnAOBY5wH6ag/AHW8eJRH9+6zo' +
  'EOAd5gv4oA30HP4ezxL+/RjqQeD75B32yAsKHG8fZhQAAJrrkeD24zj04wkFG78f6BUCAjHtAuEM' +
  '42Dy9QfjGfAfVBcDBNvukeFA4pbw/wWoGAAgqBj/BZbwQOKR4dvuAwRUF/Af4xn1B2DyDOMC4THt' +
  'AgLoFb8fBRvjCTj09uOR4JrrAABmFG8fChzICx32++RB4Bjq/v3PEv4e9BygDQv4HeYQ4Kzo/fsl' +
  'EW8ewB1qDwH6WOcA4FjnAfpqD8Adbx4lEf37rOgQ4B3mC/igDfQc/h7PEv79GOpB4PvkHfbICwoc' +
  'bx9mFAAAmuuR4PbjOPTjCQUbvx/oFQICMe0C4QzjYPL1B+MZ8B9UFwME2+6R4UDilvD/BagYACCo' +
  'GP8FlvBA4pHh2+4DBFQX8B/jGfUHYPIM4wLhMe0CAugVvx8FG+MJOPT245HgmusAAOMT3B3wGZoK' +
  'WfcJ6c/leu5x/hsOeBZEFDIJ1PrS79fslvLL/QAJNw8iDvAGdP0j9gD0X/cN/qAELwicB9wDM//r' +
  '+zb7xPw0/wYBcwHGAA==';

let playbackPrimingPromise: Promise<void> | null = null;
let playbackAudioElement: HTMLAudioElement | null = null;
let activePlaybackObjectUrl: string | null = null;
const pendingTextToSpeechRequests = new Map<string, Promise<Blob>>();

function getPlaybackAudioElement(): HTMLAudioElement {
  if (playbackAudioElement) {
    return playbackAudioElement;
  }

  const audio = new Audio();
  audio.preload = 'auto';
  audio.setAttribute('playsinline', '');
  audio.setAttribute('webkit-playsinline', '');
  playbackAudioElement = audio;
  return audio;
}

function clearActivePlaybackObjectUrl(nextObjectUrl?: string): void {
  if (!activePlaybackObjectUrl || activePlaybackObjectUrl === nextObjectUrl) {
    return;
  }

  URL.revokeObjectURL(activePlaybackObjectUrl);
  activePlaybackObjectUrl = null;
}

export function getApiKey(): string | null {
  return localStorage.getItem(API_KEY_STORAGE_KEY);
}

export function setApiKey(key: string): void {
  localStorage.setItem(API_KEY_STORAGE_KEY, key);
}

export function clearApiKey(): void {
  localStorage.removeItem(API_KEY_STORAGE_KEY);
}

interface TextToSpeechOptions {
  voice?: string;
}

interface SpeechToTextOptions {
  prompt?: string;
}

interface PlayAudioBlobOptions {
  signal?: AbortSignal;
}

export function getAudioUploadFilename(audioBlob: Blob): string {
  const mimeType = audioBlob.type.split(';', 1)[0];

  switch (mimeType) {
    case 'audio/mp4':
      return 'recording.mp4';
    case 'audio/mpeg':
      return 'recording.mp3';
    case 'audio/wav':
      return 'recording.wav';
    case 'audio/webm':
      return 'recording.webm';
    default:
      return 'recording.webm';
  }
}

function getAudioUploadFormat(audioBlob: Blob): string {
  return getAudioUploadFilename(audioBlob).split('.').pop() ?? 'webm';
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...Array.from(chunk));
  }

  return btoa(binary);
}

async function blobToBase64(audioBlob: Blob): Promise<string> {
  return arrayBufferToBase64(await audioBlob.arrayBuffer());
}

function buildOpenRouterHeaders(apiKey: string, contentType: string = 'application/json'): HeadersInit {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': contentType,
    'X-OpenRouter-Title': OPENROUTER_APP_TITLE,
  };
}

function buildOpenRouterUrl(path: string): string {
  return `${OPENROUTER_API_BASE_URL}${path}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'AbortError';
  }

  return error instanceof TypeError;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise.then(
      (value) => {
        globalThis.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  attempts: number = MAX_API_RETRY_ATTEMPTS + 1,
): Promise<Response> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = globalThis.setTimeout(() => {
      controller.abort();
    }, API_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(input, {
        ...init,
        signal: controller.signal,
      });

      globalThis.clearTimeout(timeoutId);

      if (response.ok || attempt === attempts || !isRetryableStatus(response.status)) {
        return response;
      }
    } catch (error) {
      globalThis.clearTimeout(timeoutId);
      lastError = error;
      if (attempt === attempts || !isRetryableNetworkError(error)) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error('Request failed');
}

export async function textToSpeech(
  text: string,
  options: TextToSpeechOptions = {},
): Promise<Blob> {
  const cacheKey = buildTtsCacheKey({
    text,
    voice: options.voice ?? 'alloy',
    model: TTS_MODEL,
    responseFormat: TTS_RESPONSE_FORMAT,
  });
  const pendingRequest = pendingTextToSpeechRequests.get(cacheKey);
  if (pendingRequest) {
    return pendingRequest;
  }

  const cachedBlob = await getCachedTtsBlob(cacheKey);
  if (cachedBlob) {
    return cachedBlob;
  }

  const pendingRequestAfterCacheLookup = pendingTextToSpeechRequests.get(cacheKey);
  if (pendingRequestAfterCacheLookup) {
    return pendingRequestAfterCacheLookup;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('OpenRouter API key not configured');
  }

  const requestPromise = (async () => {
    const response = await fetchWithRetry(buildOpenRouterUrl('/audio/speech'), {
      method: 'POST',
      headers: buildOpenRouterHeaders(apiKey),
      body: JSON.stringify({
        model: TTS_MODEL,
        input: text,
        voice: options.voice ?? 'alloy',
        response_format: TTS_RESPONSE_FORMAT,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
      throw new Error(error.error?.message || `TTS failed: ${response.status}`);
    }

    const audioBlob = await response.blob();
    await setCachedTtsBlob(cacheKey, audioBlob);
    return audioBlob;
  })();

  pendingTextToSpeechRequests.set(cacheKey, requestPromise);

  try {
    return await requestPromise;
  } finally {
    pendingTextToSpeechRequests.delete(cacheKey);
  }
}

export async function prefetchTextToSpeech(
  text: string,
  options: TextToSpeechOptions = {},
): Promise<boolean> {
  try {
    await textToSpeech(text, options);
    return true;
  } catch {
    return false;
  }
}

export async function speechToText(
  audioBlob: Blob,
  options: SpeechToTextOptions = {},
): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('OpenRouter API key not configured');
  }

  const response = await fetchWithRetry(buildOpenRouterUrl('/audio/transcriptions'), {
    method: 'POST',
    headers: buildOpenRouterHeaders(apiKey),
    body: JSON.stringify({
      model: STT_MODEL,
      input_audio: {
        data: await blobToBase64(audioBlob),
        format: getAudioUploadFormat(audioBlob),
      },
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
    throw new Error(error.error?.message || `STT failed: ${response.status}`);
  }

  const result = await response.json();
  return result.text;
}

export function __resetPlaybackPrimingForTests(): void {
  playbackPrimingPromise = null;
  pendingTextToSpeechRequests.clear();
  __resetTtsCacheStateForTests();
  clearActivePlaybackObjectUrl();

  if (playbackAudioElement) {
    playbackAudioElement.pause();
    playbackAudioElement.onended = null;
    playbackAudioElement.onerror = null;
    playbackAudioElement.src = '';
  }

  playbackAudioElement = null;
}

export function primeAudioPlayback(timeoutMs: number = PLAYBACK_PRIMING_TIMEOUT_MS): Promise<void> {
  if (playbackPrimingPromise) {
    return playbackPrimingPromise;
  }

  playbackPrimingPromise = (async () => {
    const audio = getPlaybackAudioElement();
    clearActivePlaybackObjectUrl();
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.src = SILENT_WAV_DATA_URI;
    audio.load();

    try {
      await withTimeout(
        audio.play(),
        timeoutMs,
        `Audio playback priming timed out after ${timeoutMs}ms`,
      );
      audio.pause();
      audio.currentTime = 0;
    } catch (error) {
      playbackPrimingPromise = null;
      throw error instanceof Error ? error : new Error('Audio playback priming failed');
    }
  })();

  return playbackPrimingPromise;
}

export function playRecordingStartCue(
  timeoutMs: number = RECORDING_START_CUE_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = getPlaybackAudioElement();
    let settled = false;

    clearActivePlaybackObjectUrl();
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.src = RECORDING_START_CUE_DATA_URI;
    audio.load();

    const timeoutId = globalThis.setTimeout(() => {
      finalize(() => {
        reject(new Error(`Recording start cue timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    const finalize = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      globalThis.clearTimeout(timeoutId);
      audio.onended = null;
      audio.onerror = null;
      callback();
    };

    audio.onended = () => {
      audio.pause();
      audio.currentTime = 0;
      finalize(resolve);
    };

    audio.onerror = () => {
      finalize(() => {
        reject(new Error('Recording start cue failed'));
      });
    };

    audio.play().catch((error) => {
      if (isRetryableNetworkError(error) || (error instanceof DOMException && error.name === 'NotAllowedError')) {
        playbackPrimingPromise = null;
      }

      finalize(() => {
        reject(error);
      });
    });
  });
}

function createAbortError(): Error {
  try {
    return new DOMException('Audio playback aborted', 'AbortError');
  } catch {
    return new Error('Audio playback aborted');
  }
}

export function playAudioBlob(
  blob: Blob,
  options: PlayAudioBlobOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const url = URL.createObjectURL(blob);
    const audio = getPlaybackAudioElement();
    let settled = false;

    clearActivePlaybackObjectUrl(url);
    activePlaybackObjectUrl = url;
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.src = url;
    audio.load();

    const finalize = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      audio.onended = null;
      audio.onerror = null;

      if (activePlaybackObjectUrl === url) {
        clearActivePlaybackObjectUrl();
      } else {
        URL.revokeObjectURL(url);
      }

      callback();
    };

    const handleAbort = () => {
      audio.pause();
      audio.currentTime = 0;
      finalize(() => {
        reject(createAbortError());
      });
    };

    audio.onended = () => {
      options.signal?.removeEventListener('abort', handleAbort);
      finalize(resolve);
    };

    audio.onerror = () => {
      options.signal?.removeEventListener('abort', handleAbort);
      finalize(() => {
        reject(new Error('Audio playback failed'));
      });
    };

    options.signal?.addEventListener('abort', handleAbort, { once: true });

    audio.play().catch((error) => {
      if (isRetryableNetworkError(error) || (error instanceof DOMException && error.name === 'NotAllowedError')) {
        playbackPrimingPromise = null;
      }

      options.signal?.removeEventListener('abort', handleAbort);
      finalize(() => {
        reject(error);
      });
    });
  });
}
