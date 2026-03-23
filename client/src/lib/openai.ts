const API_KEY_STORAGE_KEY = 'openai_api_key';
const TTS_MODEL = 'tts-1';
const STT_MODEL = 'gpt-4o-transcribe';
const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';

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

export async function textToSpeech(
  text: string,
  options: TextToSpeechOptions = {},
): Promise<Blob> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('OpenAI API key not configured');
  }

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
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
  formData.append('file', audioBlob, 'recording.webm');
  formData.append('model', STT_MODEL);
  if (options.prompt) {
    formData.append('prompt', options.prompt);
  }

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
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

export function primeAudioPlayback(): Promise<void> {
  if (playbackPrimingPromise) {
    return playbackPrimingPromise;
  }

  playbackPrimingPromise = (async () => {
    const audio = new Audio(SILENT_WAV_DATA_URI);
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.muted = true;

    try {
      await audio.play();
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
