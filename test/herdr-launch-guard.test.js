// Sitting in a herdr pane whose server is NOT the one our commands would
// reach, `unsnooze claude` must still run the agent — unwatched, with a reason
// — and must not spawn a monitor aimed at a pane id that means something else
// on the default server.
//
// Driven through the real bin with a herdr shim; never touches a real server.

import { test as baseTest, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const test = process.platform === 'win32'
  ? (name, fn) => baseTest(name, { skip: 'unix-only surface (sh/PATH shims)' }, fn)
  : baseTest;

const REAL_BIN = fileURLToPath(new URL('../bin/unsnooze.js', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-herdr-guard-'));
const SHIMS = join(DIR, 'shims');
mkdirSync(SHIMS);

after(() => rmSync(DIR, { recursive: true, force: true }));

// A herdr that exists, is new enough, and reports one session whose socket is
// NOT the socket we are ambiently pointed at.
function installHerdrShim({ sessionSocket }) {
  const shim = join(SHIMS, 'herdr');
  writeFileSync(shim, `#!/bin/sh
case "$*" in
  "--version") echo "herdr 0.8.0"; exit 0 ;;
  *"session list --json"*) printf '%s' '{"sessions":[{"name":"work","running":true,"socket_path":"${sessionSocket}"}]}'; exit 0 ;;
esac
exit 0
`);
  chmodSync(shim, 0o755);
}

function run(env = {}) {
  return spawnSync(process.execPath, [REAL_BIN, '_run', 'claude', 'hey'], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${SHIMS}:/usr/bin:/bin`,
      UNSNOOZE_STATE_DIR: join(DIR, 'state'),
      UNSNOOZE_CLAUDE_BIN: '/bin/echo',
      UNSNOOZE_MULTIPLEXER: 'herdr',
      UNSNOOZE_NOTIFICATIONS: 'off',
      TMUX: '', ZELLIJ: '', UNSNOOZE_ACTIVE: '',
      ...env,
    },
  });
}

test('a pane on a foreign socket degrades to an unwatched launch, with the reason', () => {
  installHerdrShim({ sessionSocket: '/tmp/work/herdr.sock' });
  const r = run({
    HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SESSION: 'work',
    // We are pointed at a different server than session "work" lives on.
    HERDR_SOCKET_PATH: '/tmp/somewhere-else/herdr.sock',
  });
  assert.equal(r.status, 0, `the agent must still run: ${r.stderr}`);
  assert.equal(r.stdout, 'hey\n', 'the user gets their agent');
  assert.match(r.stderr, /custom socket/, 'and is told why it is unwatched');
  assert.match(r.stderr, /without limit-watch/);

  const leases = join(DIR, 'state', 'leases');
  assert.equal(existsSync(leases) ? readdirSync(leases).length : 0, 0,
    'no lease: nothing claimed a pane it could not prove it owned');
});

test('the same pane on the matching socket is watched normally', () => {
  installHerdrShim({ sessionSocket: '/tmp/work/herdr.sock' });
  const r = run({
    HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SESSION: 'work',
    HERDR_SOCKET_PATH: '/tmp/work/herdr.sock',
    UNSNOOZE_STATE_DIR: join(DIR, 'state-ok'),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'hey\n');
  assert.doesNotMatch(r.stderr, /custom socket/,
    'a matching socket is the same server — no refusal');
});
