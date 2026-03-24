import { createDebugLogEntry, type DebugLogEntry } from './debug-log';

const PWA_DEBUG_EVENT_NAME = 'rehearsal:pwa-debug-log';
const PWA_DEBUG_LOG_BUFFER_KEY = '__rehearsalPwaDebugLogBuffer';

type GlobalWithPwaDebugBuffer = typeof globalThis & {
  [PWA_DEBUG_LOG_BUFFER_KEY]?: DebugLogEntry[];
};

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

export interface PwaDisplayModeState {
  fullscreen: boolean;
  standalone: boolean;
  minimalUi: boolean;
  iosStandalone: boolean;
}

export interface PwaRuntimeSnapshot {
  appVersion: string;
  displayMode: string;
  isOnline: boolean;
  visibilityState: string;
  isSecureContext: boolean;
  manifestHref: string;
  serviceWorkerSupported: boolean;
  serviceWorkerControlled: boolean;
  serviceWorkerInstallingState: string;
  serviceWorkerWaitingState: string;
  serviceWorkerActiveState: string;
  serviceWorkerScope: string;
  locationHref: string;
  userAgent: string;
}

function getPwaDebugLogBuffer(): DebugLogEntry[] {
  const host = globalThis as GlobalWithPwaDebugBuffer;
  if (!host[PWA_DEBUG_LOG_BUFFER_KEY]) {
    host[PWA_DEBUG_LOG_BUFFER_KEY] = [];
  }

  return host[PWA_DEBUG_LOG_BUFFER_KEY];
}

export function queuePwaDebugLog(
  event: string,
  details?: string,
  timestamp?: string,
): DebugLogEntry {
  const entry = createDebugLogEntry(event, details, timestamp);
  getPwaDebugLogBuffer().push(entry);

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent<DebugLogEntry>(PWA_DEBUG_EVENT_NAME, { detail: entry }));
  }

  return entry;
}

export function consumeQueuedPwaDebugLogs(): DebugLogEntry[] {
  const buffer = getPwaDebugLogBuffer();
  if (buffer.length === 0) {
    return [];
  }

  const entries = [...buffer];
  buffer.length = 0;
  return entries;
}

export function subscribeToPwaDebugLogs(
  listener: (entry: DebugLogEntry) => void,
): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => undefined;
  }

  const handleEvent = (event: Event) => {
    const detail = (event as CustomEvent<DebugLogEntry>).detail;
    if (detail) {
      listener(detail);
    }
  };

  window.addEventListener(PWA_DEBUG_EVENT_NAME, handleEvent);
  return () => {
    window.removeEventListener(PWA_DEBUG_EVENT_NAME, handleEvent);
  };
}

export function resolvePwaDisplayMode(state: PwaDisplayModeState): string {
  if (state.fullscreen) {
    return 'fullscreen';
  }

  if (state.standalone) {
    return 'standalone';
  }

  if (state.minimalUi) {
    return 'minimal-ui';
  }

  if (state.iosStandalone) {
    return 'ios-standalone';
  }

  return 'browser-tab';
}

function getMatchMediaMatches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia(query).matches;
}

export function getCurrentPwaDisplayMode(): string {
  const browserNavigator =
    typeof navigator !== 'undefined' ? (navigator as NavigatorWithStandalone) : undefined;

  return resolvePwaDisplayMode({
    fullscreen: getMatchMediaMatches('(display-mode: fullscreen)'),
    standalone: getMatchMediaMatches('(display-mode: standalone)'),
    minimalUi: getMatchMediaMatches('(display-mode: minimal-ui)'),
    iosStandalone: Boolean(browserNavigator?.standalone),
  });
}

export function formatPwaRuntimeSnapshot(snapshot: PwaRuntimeSnapshot): string {
  return [
    `version=${snapshot.appVersion}`,
    `mode=${snapshot.displayMode}`,
    `online=${snapshot.isOnline ? 'yes' : 'no'}`,
    `visibility=${snapshot.visibilityState}`,
    `secure=${snapshot.isSecureContext ? 'yes' : 'no'}`,
    `manifest=${snapshot.manifestHref}`,
    `sw-supported=${snapshot.serviceWorkerSupported ? 'yes' : 'no'}`,
    `sw-controller=${snapshot.serviceWorkerControlled ? 'yes' : 'no'}`,
    `sw-installing=${snapshot.serviceWorkerInstallingState}`,
    `sw-waiting=${snapshot.serviceWorkerWaitingState}`,
    `sw-active=${snapshot.serviceWorkerActiveState}`,
    `sw-scope=${snapshot.serviceWorkerScope}`,
    `location=${snapshot.locationHref}`,
  ].join(' | ');
}

async function collectPwaRuntimeSnapshot(appVersion: string): Promise<PwaRuntimeSnapshot> {
  const browserNavigator =
    typeof navigator !== 'undefined' ? (navigator as NavigatorWithStandalone) : undefined;
  const manifestHref =
    typeof document !== 'undefined'
      ? document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href ?? 'missing'
      : 'missing';
  const serviceWorkerSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

  const registration = serviceWorkerSupported
    ? await navigator.serviceWorker.getRegistration().catch(() => null)
    : null;

  return {
    appVersion,
    displayMode: getCurrentPwaDisplayMode(),
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : false,
    visibilityState: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
    isSecureContext:
      typeof window !== 'undefined' ? window.isSecureContext : false,
    manifestHref,
    serviceWorkerSupported,
    serviceWorkerControlled:
      serviceWorkerSupported && Boolean(navigator.serviceWorker.controller),
    serviceWorkerInstallingState: registration?.installing?.state ?? 'none',
    serviceWorkerWaitingState: registration?.waiting?.state ?? 'none',
    serviceWorkerActiveState: registration?.active?.state ?? 'none',
    serviceWorkerScope: registration?.scope ?? 'none',
    locationHref: typeof window !== 'undefined' ? window.location.href : 'unknown',
    userAgent: browserNavigator?.userAgent ?? 'unknown',
  };
}

export async function capturePwaRuntimeDiagnostics(
  appVersion: string,
  label: string = 'PWA Runtime Snapshot',
  includeUserAgent: boolean = false,
): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  try {
    const snapshot = await collectPwaRuntimeSnapshot(appVersion);
    queuePwaDebugLog(label, formatPwaRuntimeSnapshot(snapshot));

    if (includeUserAgent) {
      queuePwaDebugLog('PWA User Agent', snapshot.userAgent);
    }
  } catch (error) {
    queuePwaDebugLog(
      'PWA Runtime Snapshot Error',
      error instanceof Error ? error.message : 'Unable to collect runtime snapshot',
    );
  }
}

export function requestServiceWorkerDebugSnapshot(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    queuePwaDebugLog(
      'Service Worker Snapshot Unavailable',
      'Service workers are not supported in this browser',
    );
    return;
  }

  const controller = navigator.serviceWorker.controller;
  if (!controller) {
    queuePwaDebugLog(
      'Service Worker Snapshot Unavailable',
      'No active service worker is controlling this page yet',
    );
    return;
  }

  controller.postMessage({ type: 'pwa-debug-snapshot' });
  queuePwaDebugLog('Service Worker Snapshot Requested');
}
