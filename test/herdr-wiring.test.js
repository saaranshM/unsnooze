import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hookContext } from '../src/hook.js';
import { resolvePaneOwner } from '../src/launcher.js';

test('hook derives a managed herdr address from unsnooze context', () => {
  assert.deepEqual(hookContext({
    UNSNOOZE_MUX: 'herdr',
    UNSNOOZE_PANE: 'w2:p4',
    UNSNOOZE_PANE_OWNER: 'managed-session',
    HERDR_PANE_ID: 'ambient-pane',
    HERDR_SESSION: 'ambient-session',
    ZELLIJ_PANE_ID: 'wrong-pane',
  }, {}), {
    muxName: 'herdr', pane: 'w2:p4', paneOwner: 'managed-session',
  });
});

test('hook derives an unmanaged herdr address and defaults owner to default', () => {
  assert.deepEqual(hookContext({
    HERDR_PANE_ID: 'w1:p1',
    ZELLIJ_PANE_ID: 'wrong-pane',
  }, {}), {
    muxName: 'herdr', pane: 'w1:p1', paneOwner: 'default',
  });
  assert.equal(hookContext({ HERDR_PANE_ID: 'w1:p1', HERDR_SESSION: 'named' }, {}).paneOwner, 'named');
});

test('launcher resolves herdr pane owner from managed or ambient session', () => {
  assert.equal(resolvePaneOwner('herdr', {
    UNSNOOZE_MUX: 'herdr', UNSNOOZE_PANE_OWNER: 'managed', HERDR_SESSION: 'ambient',
  }), 'managed');
  assert.equal(resolvePaneOwner('herdr', { HERDR_SESSION: 'ambient' }), 'ambient');
  assert.equal(resolvePaneOwner('herdr', {}), 'default');
  assert.equal(resolvePaneOwner('tmux', { HERDR_SESSION: 'ambient' }), null);
});
