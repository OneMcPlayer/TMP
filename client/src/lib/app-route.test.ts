import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAppRouteHref, getAppRouteFromHash } from './app-route';

test('getAppRouteFromHash resolves the audio lab hashes', () => {
  assert.equal(getAppRouteFromHash('#/audio-lab'), 'audio-lab');
  assert.equal(getAppRouteFromHash('#audio-lab'), 'audio-lab');
  assert.equal(getAppRouteFromHash('#/audio-lab?step=media'), 'audio-lab');
});

test('getAppRouteFromHash resolves the realtime lab hashes', () => {
  assert.equal(getAppRouteFromHash('#/realtime-lab'), 'realtime-lab');
  assert.equal(getAppRouteFromHash('#realtime-lab'), 'realtime-lab');
  assert.equal(getAppRouteFromHash('#/realtime-lab?session=debug'), 'realtime-lab');
});

test('getAppRouteFromHash resolves the live memorization hashes', () => {
  assert.equal(getAppRouteFromHash('#/live-memorization'), 'live-memorization');
  assert.equal(getAppRouteFromHash('#live-memorization'), 'live-memorization');
  assert.equal(getAppRouteFromHash('#/live-memorization?scene=1'), 'live-memorization');
});

test('getAppRouteFromHash resolves the tap rehearsal hashes', () => {
  assert.equal(getAppRouteFromHash('#/tap-rehearsal'), 'tap-rehearsal');
  assert.equal(getAppRouteFromHash('#tap-rehearsal'), 'tap-rehearsal');
  assert.equal(getAppRouteFromHash('#/tap-rehearsal?scene=1'), 'tap-rehearsal');
});

test('getAppRouteFromHash falls back to rehearsal for unknown hashes', () => {
  assert.equal(getAppRouteFromHash(''), 'rehearsal');
  assert.equal(getAppRouteFromHash('#/'), 'rehearsal');
  assert.equal(getAppRouteFromHash('#/anything-else'), 'rehearsal');
});

test('buildAppRouteHref returns stable hashes for app sections', () => {
  assert.equal(buildAppRouteHref('rehearsal'), '#/');
  assert.equal(buildAppRouteHref('audio-lab'), '#/audio-lab');
  assert.equal(buildAppRouteHref('realtime-lab'), '#/realtime-lab');
  assert.equal(buildAppRouteHref('live-memorization'), '#/live-memorization');
  assert.equal(buildAppRouteHref('tap-rehearsal'), '#/tap-rehearsal');
});
