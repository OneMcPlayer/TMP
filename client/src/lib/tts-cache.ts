import { APP_VERSION } from './version';

const TTS_CACHE_NAME_PREFIX = 'rehearsal-partner-tts-';
const TTS_CACHE_NAME = `${TTS_CACHE_NAME_PREFIX}${APP_VERSION}`;
const TTS_CACHE_REQUEST_BASE_URL = 'https://rehearsal-partner.local';

let cleanupPromise: Promise<void> | null = null;

function getCacheStorage(): CacheStorage | null {
  if (typeof globalThis === 'undefined' || !('caches' in globalThis)) {
    return null;
  }

  return globalThis.caches;
}

function normalizeTtsText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hashCacheInput(input: string): string {
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function buildCacheRequest(cacheKey: string): Request {
  return new Request(`${TTS_CACHE_REQUEST_BASE_URL}/__tts_cache__/${encodeURIComponent(cacheKey)}`);
}

async function cleanupLegacyCaches(): Promise<void> {
  const cacheStorage = getCacheStorage();
  if (!cacheStorage) {
    return;
  }

  const cacheNames = await cacheStorage.keys();
  await Promise.all(
    cacheNames
      .filter((cacheName) => cacheName.startsWith(TTS_CACHE_NAME_PREFIX) && cacheName !== TTS_CACHE_NAME)
      .map((cacheName) => cacheStorage.delete(cacheName)),
  );
}

async function openTtsCache(): Promise<Cache | null> {
  const cacheStorage = getCacheStorage();
  if (!cacheStorage) {
    return null;
  }

  if (!cleanupPromise) {
    cleanupPromise = cleanupLegacyCaches()
      .catch(() => undefined)
      .finally(() => {
        cleanupPromise = null;
      });
  }

  return cacheStorage.open(TTS_CACHE_NAME).catch(() => null);
}

export function buildTtsCacheKey({
  text,
  voice,
  model,
  responseFormat,
}: {
  text: string;
  voice: string;
  model: string;
  responseFormat: string;
}): string {
  const normalizedText = normalizeTtsText(text);
  return [
    APP_VERSION,
    model,
    voice,
    responseFormat,
    normalizedText.length,
    hashCacheInput(`${model}\n${voice}\n${responseFormat}\n${normalizedText}`),
  ].join(':');
}

export async function getCachedTtsBlob(cacheKey: string): Promise<Blob | null> {
  const cache = await openTtsCache();
  if (!cache) {
    return null;
  }

  const response = await cache.match(buildCacheRequest(cacheKey));
  if (!response) {
    return null;
  }

  return response.blob();
}

export async function setCachedTtsBlob(cacheKey: string, blob: Blob): Promise<void> {
  const cache = await openTtsCache();
  if (!cache) {
    return;
  }

  await cache.put(
    buildCacheRequest(cacheKey),
    new Response(blob, {
      headers: {
        'content-type': blob.type || 'audio/mpeg',
        'x-rehearsal-partner-cache-key': cacheKey,
      },
    }),
  );
}

export function __resetTtsCacheStateForTests(): void {
  cleanupPromise = null;
}
