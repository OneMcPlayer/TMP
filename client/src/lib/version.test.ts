import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchLatestVersion, isUpdateAvailable } from './version';

test('isUpdateAvailable returns true only when latest version differs', () => {
  assert.equal(isUpdateAvailable('1.0.0', '1.0.0'), false);
  assert.equal(isUpdateAvailable('1.0.0', '1.1.0'), true);
  assert.equal(isUpdateAvailable(' 1.0.0 ', '1.0.1'), true);
  assert.equal(isUpdateAvailable('1.0.0', null), false);
});

test('fetchLatestVersion returns metadata for valid payload', async () => {
  const fetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ version: '1.2.3', releasedAt: '2026-03-23T00:00:00Z' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const result = await fetchLatestVersion(fetcher, '/');

  assert.deepEqual(result, {
    version: '1.2.3',
    releasedAt: '2026-03-23T00:00:00Z',
  });
});

test('fetchLatestVersion returns null for invalid payload or failed response', async () => {
  const badPayloadFetcher: typeof fetch = async () =>
    new Response(JSON.stringify({ version: '' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const failedResponseFetcher: typeof fetch = async () =>
    new Response('not found', { status: 404 });

  assert.equal(await fetchLatestVersion(badPayloadFetcher, '/'), null);
  assert.equal(await fetchLatestVersion(failedResponseFetcher, '/'), null);
});
