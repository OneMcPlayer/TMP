import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  consumeQueuedPwaDebugLogs,
  formatPwaRuntimeSnapshot,
  queuePwaDebugLog,
  resolvePwaDisplayMode,
} from './pwa-debug';

test('queuePwaDebugLog buffers entries until they are consumed', () => {
  consumeQueuedPwaDebugLogs();

  queuePwaDebugLog(
    'Service Worker Registered',
    'scope=https://example.test/',
    '2026-03-24T12:00:00Z',
  );

  const entries = consumeQueuedPwaDebugLogs();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.event, 'Service Worker Registered');
  assert.equal(entries[0]?.details, 'scope=https://example.test/');
  assert.equal(entries[0]?.timestamp, '2026-03-24T12:00:00Z');
  assert.equal(consumeQueuedPwaDebugLogs().length, 0);
});

test('resolvePwaDisplayMode prefers installed display modes over browser tabs', () => {
  assert.equal(
    resolvePwaDisplayMode({
      fullscreen: false,
      standalone: true,
      minimalUi: false,
      iosStandalone: false,
    }),
    'standalone',
  );

  assert.equal(
    resolvePwaDisplayMode({
      fullscreen: false,
      standalone: false,
      minimalUi: false,
      iosStandalone: true,
    }),
    'ios-standalone',
  );

  assert.equal(
    resolvePwaDisplayMode({
      fullscreen: false,
      standalone: false,
      minimalUi: false,
      iosStandalone: false,
    }),
    'browser-tab',
  );
});

test('formatPwaRuntimeSnapshot produces a compact troubleshooting summary', () => {
  const summary = formatPwaRuntimeSnapshot({
    appVersion: '1.0.10',
    displayMode: 'standalone',
    isOnline: true,
    visibilityState: 'visible',
    isSecureContext: true,
    manifestHref: 'https://example.test/manifest.webmanifest',
    serviceWorkerSupported: true,
    serviceWorkerControlled: true,
    serviceWorkerInstallingState: 'none',
    serviceWorkerWaitingState: 'installed',
    serviceWorkerActiveState: 'activated',
    serviceWorkerScope: 'https://example.test/',
    locationHref: 'https://example.test/app',
    userAgent: 'ExampleBrowser/1.0',
  });

  assert.equal(
    summary,
    [
      'version=1.0.10',
      'mode=standalone',
      'online=yes',
      'visibility=visible',
      'secure=yes',
      'manifest=https://example.test/manifest.webmanifest',
      'sw-supported=yes',
      'sw-controller=yes',
      'sw-installing=none',
      'sw-waiting=installed',
      'sw-active=activated',
      'sw-scope=https://example.test/',
      'location=https://example.test/app',
    ].join(' | '),
  );
});
