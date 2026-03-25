const API_KEY_STORAGE_KEY = 'openai_api_key';
const TTS_MODEL = 'tts-1';
const STT_MODEL = 'gpt-4o-transcribe';
const API_REQUEST_TIMEOUT_MS = 15_000;
const MAX_API_RETRY_ATTEMPTS = 1;
const PLAYBACK_PRIMING_TIMEOUT_MS = 1_500;
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

let playbackPrimingPromise: Promise<void> | null = null;

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
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  const response = await fetchWithRetry('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: text,
      voice: options.voice ?? 'alloy',
      response_format: 'mp3',
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
    throw new Error(error.error?.message || `TTS failed: ${response.status}`);
  }

  return await response.blob();
}

export async function speechToText(
  audioBlob: Blob,
  options: SpeechToTextOptions = {},
): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  const formData = new FormData();
  formData.append('file', audioBlob, getAudioUploadFilename(audioBlob));
  formData.append('model', STT_MODEL);
  if (options.prompt) {
    formData.append('prompt', options.prompt);
  }

  const response = await fetchWithRetry('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
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
}

export function primeAudioPlayback(timeoutMs: number = PLAYBACK_PRIMING_TIMEOUT_MS): Promise<void> {
  if (playbackPrimingPromise) {
    return playbackPrimingPromise;
  }

  playbackPrimingPromise = (async () => {
    const audio = new Audio(SILENT_WAV_DATA_URI);
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
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

export function playAudioBlob(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');

    audio.onended = () => {
      URL.revokeObjectURL(url);
      resolve();
    };

    audio.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(new Error('Audio playback failed'));
    };

    audio.play().catch(reject);
  });
}
