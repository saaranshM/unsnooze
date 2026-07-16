// F5 end-to-end: when tmux cannot start the wrapped session (duplicate name,
// no terminal, dead socket), the user's `claude` must still run — unwatched,
// with a message — instead of flashing a session open/closed and exiting 1.
// Driven through the real bin with a fake `tmux` shim on PATH; never touches
// a real tmux server.

import { test as baseTest, after } from 'node:test';

// These tests drive unix binaries (/bin/echo, sh shims) and PATH semantics —
// the surfaces under test (shell wrappers, tmux fallback) are unix-only by
// design (native Windows runs detection-only). Skip on win32, honestly.
const test = process.platform === 'win32'
  ? (name, fn) => baseTest(name, { skip: 'unix-only surface (sh/PATH/tmux)' }, fn)
  : baseTest;
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REAL_BIN = fileURLToPath(new URL('../bin/unsnooze.js', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-launchfb-'));
const SHIMS = join(DIR, 'shims');
mkdirSync(SHIMS);

after(() => rmSync(DIR, { recursive: true, force: true }));

function installTmuxShim(newSessionBody) {
  const shim = join(SHIMS, 'tmux');
  writeFileSync(shim, `#!/bin/sh
case "$1" in
  -V) echo "tmux 3.7b"; exit 0 ;;
  has-session) exit 1 ;;
  new-session) ${newSessionBody} ;;
  *) exit 0 ;;
esac
`);
  chmodSync(shim, 0o755);
}

function run(args = ['_run', 'claude', 'hey']) {
  return spawnSync(process.execPath, [REAL_BIN, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${SHIMS}:/usr/bin:/bin`,
      UNSNOOZE_STATE_DIR: join(DIR, 'state'),
      UNSNOOZE_CLAUDE_BIN: '/bin/echo',
      UNSNOOZE_MULTIPLEXER: 'tmux',
      TMUX: '', ZELLIJ: '', UNSNOOZE_ACTIVE: '',
    },
  });
}

test('a duplicate-session tmux failure degrades to the unwatched agent CLI', () => {
  installTmuxShim('echo "duplicate session: unsnooze" >&2; exit 1');
  const r = run();
  assert.equal(r.status, 0, `agent must still run: ${r.stderr}`);
  assert.equal(r.stdout, 'hey\n', 'agent gets its args');
  assert.match(r.stderr, /without limit-watch/, 'user is told watching is off');
});

test('an open-terminal-failed tmux failure also degrades instead of dying', () => {
  installTmuxShim('echo "open terminal failed: not a terminal" >&2; exit 1');
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'hey\n');
  assert.match(r.stderr, /without limit-watch/);
});

test('a clean wrapped session exit is NOT treated as a failure (no double-run)', () => {
  // The shim "runs the session" successfully: exit 0. The agent must not be
  // run a second time by any fallback path.
  installTmuxShim('exit 0');
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'agent ran inside the (fake) session only — never re-run outside');
  assert.doesNotMatch(r.stderr, /without limit-watch/);
});
