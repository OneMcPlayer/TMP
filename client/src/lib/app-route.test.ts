import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAppRouteHref, getAppRouteFromHash } from './app-route';

test('getAppRouteFromHash resolves the audio lab hashes', () => {
  assert.equal(getAppRouteFromHash('#/audio-lab'), 'audio-lab');
  assert.equal(getAppRouteFromHash('#audio-lab'), 'audio-lab');
  assert.equal(getAppRouteFromHash('#/audio-lab?step=media'), 'audio-lab');
});

test('getAppRouteFromHash falls back to rehearsal for unknown hashes', () => {
  assert.equal(getAppRouteFromHash(''), 'rehearsal');
  assert.equal(getAppRouteFromHash('#/'), 'rehearsal');
  assert.equal(getAppRouteFromHash('#/anything-else'), 'rehearsal');
});

test('buildAppRouteHref returns stable hashes for app sections', () => {
  assert.equal(buildAppRouteHref('rehearsal'), '#/');
  assert.equal(buildAppRouteHref('audio-lab'), '#/audio-lab');
});
