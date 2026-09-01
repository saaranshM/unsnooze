import { test as baseTest, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isPassthrough } from '../src/launcher.js';

const test = process.platform === 'win32'
  ? (name, fn) => baseTest(name, { skip: 'unix-only surface (sh/PATH/tmux)' }, fn)
  : baseTest;

const REAL_BIN = fileURLToPath(new URL('../bin/unsnooze.js', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-passthrough-'));
const SHIMS = join(DIR, 'shims');
mkdirSync(SHIMS);

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

test('isPassthrough identifies informational and non-interactive flags', () => {
  for (const flag of ['--help', '-h', '--version', '-v', '-V', '-p', '--print']) {
    assert.equal(isPassthrough([flag]), true, `expected ${flag} to be passthrough`);
    assert.equal(isPassthrough(['foo', flag, 'bar']), true, `expected embedded ${flag} to be passthrough`);
  }
  assert.equal(isPassthrough([]), false);
  assert.equal(isPassthrough(['hey']), false);
  assert.equal(isPassthrough(['-c']), false);
  assert.equal(isPassthrough(['--resume', '123']), false);
  assert.equal(isPassthrough(['--dangerously-skip-permissions']), false);
});

function installTmuxShim(newSessionBody = 'exit 1') {
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

function run(args = ['_run', 'claude', '--help'], extraEnv = {}) {
  return spawnSync(process.execPath, [REAL_BIN, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${SHIMS}:/usr/bin:/bin`,
      UNSNOOZE_STATE_DIR: join(DIR, 'state'),
      UNSNOOZE_CLAUDE_BIN: '/bin/echo',
      UNSNOOZE_MULTIPLEXER: 'tmux',
      TMUX: '', ZELLIJ: '', UNSNOOZE_ACTIVE: '',
      ...extraEnv,
    },
  });
}

test('claude --help runs plain agent directly without wrapping into multiplexer', () => {
  // If launcher attempts to wrap into tmux, new-session will fail with exit 42
  installTmuxShim('echo "tmux should not be called for --help" >&2; exit 42');

  for (const flag of ['--help', '-h', '--version', '-v', '-V']) {
    const r = run(['_run', 'claude', flag]);
    assert.equal(r.status, 0, `expected exit 0 for ${flag}, got ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout, `${flag}\n`, `agent gets ${flag} untouched`);
    assert.doesNotMatch(r.stderr, /without limit-watch|tmux should not be called/,
      `${flag} should be intentional passthrough, not fallback`);
  }
});

test('claude --help does not prepend launchExtraArgs', () => {
  installTmuxShim('exit 42');
  const r = run(['_run', 'claude', '--help'], {
    UNSNOOZE_LAUNCH_EXTRA_ARGS_CLAUDE: '--autocompact 400000',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '--help\n', 'launchExtraArgs must not be prepended on --help');
});
