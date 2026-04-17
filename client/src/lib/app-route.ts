export type AppRoute = 'rehearsal' | 'audio-lab' | 'realtime-lab';

const AUDIO_LAB_HASHES = new Set(['#audio-lab', '#/audio-lab']);
const REALTIME_LAB_HASHES = new Set(['#realtime-lab', '#/realtime-lab']);
const REHEARSAL_HASHES = new Set(['', '#', '#/', '#rehearsal', '#/rehearsal']);

export function getAppRouteFromHash(hash: string): AppRoute {
  const normalizedHash = hash.trim().toLowerCase();

  if (AUDIO_LAB_HASHES.has(normalizedHash)) {
    return 'audio-lab';
  }

  if (REALTIME_LAB_HASHES.has(normalizedHash)) {
    return 'realtime-lab';
  }

  if (REHEARSAL_HASHES.has(normalizedHash)) {
    return 'rehearsal';
  }

  if (normalizedHash.includes('audio-lab')) {
    return 'audio-lab';
  }

  if (normalizedHash.includes('realtime-lab')) {
    return 'realtime-lab';
  }

  return 'rehearsal';
}

export function getCurrentAppRoute(): AppRoute {
  if (typeof window === 'undefined') {
    return 'rehearsal';
  }

  return getAppRouteFromHash(window.location.hash);
}

export function buildAppRouteHref(route: AppRoute): string {
  if (route === 'audio-lab') {
    return '#/audio-lab';
  }

  if (route === 'realtime-lab') {
    return '#/realtime-lab';
  }

  return '#/';
}
