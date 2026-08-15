// `unsnooze report` is the only capture that wants history rather than the
// live screen, and the only reason herdr's driver carries a second read path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { historyCapture } from '../src/report.js';

test('a backend with real host scrollback is captured through capturePane', async () => {
  const calls = [];
  const tmuxLike = {
    capturePane: async (pane, lines) => { calls.push(['capturePane', pane, lines]); return 'history'; },
  };
  assert.equal(await historyCapture(tmuxLike)('%1', 200), 'history');
  assert.deepEqual(calls, [['capturePane', '%1', 200]]);
});

test('a backend whose capturePane is pinned to the live screen is captured through captureScrollback', async () => {
  const calls = [];
  const herdrLike = {
    capturePane: async () => { calls.push(['capturePane']); return 'just the visible bottom'; },
    captureScrollback: async (pane, lines) => { calls.push(['captureScrollback', pane, lines]); return 'history'; },
  };
  assert.equal(await historyCapture(herdrLike)('w1:p1', 200), 'history');
  assert.deepEqual(calls, [['captureScrollback', 'w1:p1', 200]],
    'capturePane would have returned one screen, losing the context the report is for');
});

test('the chosen capture keeps its backend as `this`', async () => {
  const bound = {
    marker: 'kept',
    async captureScrollback() { return this.marker; },
  };
  assert.equal(await historyCapture(bound)('w1:p1', 200), 'kept');
});
