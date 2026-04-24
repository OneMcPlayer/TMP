export type AppRoute =
  | 'rehearsal'
  | 'audio-lab'
  | 'realtime-lab'
  | 'live-memorization'
  | 'tap-rehearsal';

const AUDIO_LAB_HASHES = new Set(['#audio-lab', '#/audio-lab']);
const REALTIME_LAB_HASHES = new Set(['#realtime-lab', '#/realtime-lab']);
const LIVE_MEMORIZATION_HASHES = new Set(['#live-memorization', '#/live-memorization']);
const TAP_REHEARSAL_HASHES = new Set(['#tap-rehearsal', '#/tap-rehearsal']);
const REHEARSAL_HASHES = new Set(['', '#', '#/', '#rehearsal', '#/rehearsal']);

export function getAppRouteFromHash(hash: string): AppRoute {
  const normalizedHash = hash.trim().toLowerCase();

  if (AUDIO_LAB_HASHES.has(normalizedHash)) {
    return 'audio-lab';
  }

  if (REALTIME_LAB_HASHES.has(normalizedHash)) {
    return 'realtime-lab';
  }

  if (LIVE_MEMORIZATION_HASHES.has(normalizedHash)) {
    return 'live-memorization';
  }

  if (TAP_REHEARSAL_HASHES.has(normalizedHash)) {
    return 'tap-rehearsal';
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

  if (normalizedHash.includes('live-memorization')) {
    return 'live-memorization';
  }

  if (normalizedHash.includes('tap-rehearsal')) {
    return 'tap-rehearsal';
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

  if (route === 'live-memorization') {
    return '#/live-memorization';
  }

  if (route === 'tap-rehearsal') {
    return '#/tap-rehearsal';
  }

  return '#/';
}
