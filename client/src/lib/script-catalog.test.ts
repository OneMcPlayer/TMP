import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SCRIPT_OPTIONS,
  buildScriptAssetUrl,
  fetchRawScript,
  getScriptOptionById,
} from './script-catalog';

test('script catalog includes Processo al Potere as a selectable text', () => {
  const option = getScriptOptionById('processo-al-potere');

  assert.equal(option.title, 'Processo al Potere');
  assert.equal(option.path, 'scripts/processo-al-potere.json');
  assert.equal(SCRIPT_OPTIONS.some((candidate) => candidate.id === 'finale-di-partita'), true);
});

test('getScriptOptionById falls back to the default script', () => {
  assert.equal(getScriptOptionById('missing').id, 'finale-di-partita');
  assert.equal(getScriptOptionById(null).id, 'finale-di-partita');
});

test('buildScriptAssetUrl respects the deployment base URL', () => {
  const option = getScriptOptionById('processo-al-potere');

  assert.equal(buildScriptAssetUrl(option, './'), './scripts/processo-al-potere.json');
  assert.equal(buildScriptAssetUrl(option, '/repo'), '/repo/scripts/processo-al-potere.json');
});

test('fetchRawScript loads the selected script asset', async () => {
  const option = getScriptOptionById('processo-al-potere');
  const fetcher: typeof fetch = async (input) => {
    assert.equal(input, './scripts/processo-al-potere.json');
    return new Response(
      JSON.stringify({
        title: 'PROCESSO AL POTERE',
        language: 'it',
        lines: [{ speaker: 'GIUDICE', line: 'Cominciamo.' }],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };

  assert.deepEqual(await fetchRawScript(option, fetcher, './'), {
    title: 'PROCESSO AL POTERE',
    language: 'it',
    lines: [{ speaker: 'GIUDICE', line: 'Cominciamo.' }],
  });
});
