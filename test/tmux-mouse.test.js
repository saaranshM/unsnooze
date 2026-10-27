import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTmux } from '../src/multiplexers/tmux.js';
import { assessPane } from '../src/resumer.js';

function fixture({ owned = true, local = '', status = 0 } = {}) {
  const calls = [];
  const mux = createTmux({ platform: 'linux', env: {}, ownsSessionFn: (mux, name) => owned && mux === 'tmux' && name === 'unsnooze-2',
    spawner: (_file, args, opts) => {
      calls.push({ args, opts });
      if (args[0] === 'display-message') return { status, stdout: '$12\tunsnooze-2\n' };
      if (args[0] === 'show-options') return { status: 0, stdout: local };
      return { status: 0 };
    },
  });
  return { mux, calls };
}

test('an owned session with inherited defaults gets mouse on locally, never globally', () => {
  const { mux, calls } = fixture();
  assert.equal(mux.configureManagedPane('%4'), true);
  assert.deepEqual(calls.at(-1).args, ['set-option', '-t', '$12', 'mouse', 'on']);
  assert.equal(calls.some(c => c.args.includes('-g') || c.args[0] === 'bind-key'), false);
  assert.ok(calls.every(c => c.opts.sync));
});

test('borrowed sessions and explicit per-session mouse choices are preserved', () => {
  for (const options of [{ owned: false }, { local: 'off\n' }, { local: 'on\n' }, { status: 1 }]) {
    const { mux, calls } = fixture(options);
    assert.equal(mux.configureManagedPane('%4'), false);
    assert.equal(calls.some(c => c.args[0] === 'set-option'), false);
  }
  const mux = createTmux({ spawner: () => { throw new Error('tmux unavailable'); } });
  assert.equal(mux.configureManagedPane('%4'), false);
});

test('revival records ownership before creating a session, but does not claim an existing session', async () => {
  for (const exists of [false, true]) {
    const events = [];
    const mux = createTmux({ platform: 'linux', env: {},
      recordSessionFn: record => events.push(['own', record.name]),
      spawner: async (_file, args) => {
        if (args[0] === 'has-session') { if (!exists) throw new Error('no session'); return ''; }
        events.push([args[0]]);
        return '%9\n';
      },
    });
    await mux.newWindow('revival', '/tmp/project', { file: 'agent', args: [], env: {} });
    assert.deepEqual(events, exists ? [['new-window']] : [['own', 'revival'], ['new-session']]);
  }
});

test('scrollback is a busy input destination, so wake text cannot be sent as copy-mode commands', async () => {
  const agent = { id: 'fixture', patterns: { limitPatterns: [], resetPatterns: [], busyPatterns: [], idleRegex: />/ },
    isForegroundCommand: () => true };
  const mux = { paneAlive: async () => true, capturePane: async () => '> ', paneInMode: async () => true,
    paneCurrentCommand: async () => 'node' };
  const result = await assessPane({ pane: '%fixture', agent: 'fixture' }, agent, { mux, matchesLease: async () => true });
  assert.equal(result.busy, true);
  assert.equal(result.inMode, true);
});
