export type AppRoute = 'rehearsal' | 'audio-lab';

const AUDIO_LAB_HASHES = new Set(['#audio-lab', '#/audio-lab']);
const REHEARSAL_HASHES = new Set(['', '#', '#/', '#rehearsal', '#/rehearsal']);

export function getAppRouteFromHash(hash: string): AppRoute {
  const normalizedHash = hash.trim().toLowerCase();

  if (AUDIO_LAB_HASHES.has(normalizedHash)) {
    return 'audio-lab';
  }

  if (REHEARSAL_HASHES.has(normalizedHash)) {
    return 'rehearsal';
  }

  return normalizedHash.includes('audio-lab') ? 'audio-lab' : 'rehearsal';
}

export function getCurrentAppRoute(): AppRoute {
  if (typeof window === 'undefined') {
    return 'rehearsal';
  }

  return getAppRouteFromHash(window.location.hash);
}

export function buildAppRouteHref(route: AppRoute): string {
  return route === 'audio-lab' ? '#/audio-lab' : '#/';
}
