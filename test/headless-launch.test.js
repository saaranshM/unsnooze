// Launching under the headless backend, driven through the real bin.
//
// The behaviour that matters: a machine with no multiplexer must still run the
// agent AND still be watched (hook + transcript), instead of the old native-
// Windows dead end that printed "run inside WSL" and ran it unwatched.

import { test as baseTest, after } from 'node:test';

// Drives /bin/echo as the agent binary, so the harness itself is unix-only.
// The Windows-facing behaviour is covered by platform-injected tests
// (hook command, PowerShell wrapper, process birth) rather than here.
const test = process.platform === 'win32'
  ? (name, fn) => baseTest(name, { skip: 'unix-only harness (/bin/echo agent shim)' }, fn)
  : baseTest;
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REAL_BIN = fileURLToPath(new URL('../bin/unsnooze.js', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-headless-launch-'));
const EMPTY_PATH = join(DIR, 'nobin');
mkdirSync(EMPTY_PATH);

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function run(extraEnv = {}, args = ['_run', 'claude', 'hey']) {
  return spawnSync(process.execPath, [REAL_BIN, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      // No tmux/zellij/herdr anywhere on PATH — the native-Windows situation.
      PATH: `${EMPTY_PATH}:/usr/bin:/bin`,
      UNSNOOZE_STATE_DIR: join(DIR, 'state'),
      UNSNOOZE_CLAUDE_BIN: '/bin/echo',
      TMUX: '', ZELLIJ: '', HERDR_ENV: '', CMUX_SOCKET_PATH: '', UNSNOOZE_ACTIVE: '',
      ...extraEnv,
    },
  });
}

test('with no multiplexer installed the agent runs and is still watched', () => {
  const r = run({ UNSNOOZE_MULTIPLEXER: 'headless' });
  assert.equal(r.status, 0, `agent must run: ${r.stderr}`);
  assert.equal(r.stdout, 'hey\n', 'agent gets its args');
  assert.doesNotMatch(r.stderr, /without limit-watch/,
    'headless watches via hook + transcript — it is not the unwatched fallback');
  assert.doesNotMatch(r.stderr, /WSL/, 'the native-Windows dead end is gone');
});

test('auto-detection falls back to headless instead of guessing a missing tmux', () => {
  const r = run();   // multiplexer: auto, nothing installed
  assert.equal(r.status, 0, `agent must run: ${r.stderr}`);
  assert.equal(r.stdout, 'hey\n');
  assert.doesNotMatch(r.stderr, /tmux not found/,
    'no multiplexer installed is a headless situation, not a missing-tmux error');
  assert.match(r.stderr, /headless/i, 'the user is told which mode they are in');
});

test('the headless notice names a concrete way to get pane-level watching', () => {
  const r = run();
  assert.match(r.stderr, /tmux|WSL/,
    'a degraded mode must say how to upgrade out of it');
});

test('launchExtraArgs reach the agent the user starts, ahead of their own args', () => {
  const r = run({
    UNSNOOZE_MULTIPLEXER: 'headless',
    UNSNOOZE_LAUNCH_EXTRA_ARGS_CLAUDE: '--autocompact 400000',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '--autocompact 400000 hey\n',
    'flags go before the positional prompt, where claude expects them');
});

test('a nested launch does not stack launchExtraArgs a second time', () => {
  // Inside an unsnooze-managed session the wrapper still shadows `claude`; the
  // pass-through must not re-apply flags the outer launch already added.
  const r = run({
    UNSNOOZE_MULTIPLEXER: 'headless',
    UNSNOOZE_LAUNCH_EXTRA_ARGS_CLAUDE: '--autocompact 400000',
    UNSNOOZE_ACTIVE: '1',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'hey\n');
});

test('a revive inherits launchExtraArgs, so --autocompact survives the wake', () => {
  // The resumer reopens through `_run <agent> --resume <id> "<msg>"`, and that
  // re-enters the launcher with UNSNOOZE_ACTIVE scrubbed. A session-lifetime
  // flag would be pointless if it were dropped by the very restart that a
  // context-heavy overnight run depends on.
  const r = run(
    { UNSNOOZE_MULTIPLEXER: 'headless', UNSNOOZE_LAUNCH_EXTRA_ARGS_CLAUDE: '--autocompact 400000' },
    ['_run', 'claude', '--resume', 'abc-123', 'carry on'],
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '--autocompact 400000 --resume abc-123 carry on\n');
});
