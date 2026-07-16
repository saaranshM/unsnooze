// Upgrade-window fail-safe: when src/ is missing or half-written (npm -g
// reinstall in flight), the bin router must never brick the user's agent
// command — agent-launch paths degrade to the plain CLI, background paths
// (hook/monitor/daemon) exit 0 quietly.
//
// Reproduction: copy bin/unsnooze.js alone into a temp dir so its ../src/
// imports genuinely do not exist — the exact half-installed layout observed
// in the 2026-07-15 incident (12,989 MODULE_NOT_FOUND daemon crashes).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REAL_BIN = fileURLToPath(new URL('../bin/unsnooze.js', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-failsafe-'));
mkdirSync(join(DIR, 'bin'));
const BROKEN_BIN = join(DIR, 'bin', 'unsnooze.js');
copyFileSync(REAL_BIN, BROKEN_BIN);   // bin exists, ../src/ does not

after(() => rmSync(DIR, { recursive: true, force: true }));

function run(args, env = {}) {
  return spawnSync(process.execPath, [BROKEN_BIN, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      UNSNOOZE_STATE_DIR: join(DIR, 'state'),
      UNSNOOZE_CLAUDE_BIN: '/bin/echo',
      UNSNOOZE_CODEX_BIN: '/bin/echo',
      ...env,
    },
  });
}

test('_run claude with missing src/ runs the plain agent CLI', () => {
  const r = run(['_run', 'claude', 'hello', 'world']);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.equal(r.stdout, 'hello world\n', 'agent must receive its args untouched');
  assert.match(r.stderr, /without limit-watch/, 'must tell the user watching is off');
  assert.doesNotMatch(r.stderr, /MODULE_NOT_FOUND|Cannot find module/, 'no stack spray');
});

test('default (bare claude args) path with missing src/ runs the plain agent CLI', () => {
  const r = run(['-c']);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.equal(r.stdout, '-c\n');
  assert.doesNotMatch(r.stderr, /MODULE_NOT_FOUND|Cannot find module/);
});

test('_run for a non-claude agent falls back to that agent bin', () => {
  const r = run(['_run', 'codex', 'resume']);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.equal(r.stdout, 'resume\n');
});

test('fallback agent env propagates UNSNOOZE_ACTIVE=1 (recursion guard)', () => {
  // /usr/bin/printenv exits 1 when the variable is unset — the assert on
  // status doubles as the assertion that the guard is present.
  const r = run(['_run', 'claude'], { UNSNOOZE_CLAUDE_BIN: '/usr/bin/printenv' });
  const rr = spawnSync(process.execPath, [BROKEN_BIN, '_run', 'claude', 'UNSNOOZE_ACTIVE'], {
    encoding: 'utf-8',
    env: { ...process.env, UNSNOOZE_STATE_DIR: join(DIR, 'state'), UNSNOOZE_CLAUDE_BIN: '/usr/bin/printenv' },
  });
  assert.equal(rr.status, 0, `printenv UNSNOOZE_ACTIVE must find it set: ${rr.stderr}`);
  assert.equal(rr.stdout.trim(), '1');
  assert.ok(r); // first call exercised the no-args path without crashing
});

test('_hook-stopfailure with missing src/ exits 0 silently', () => {
  const r = run(['_hook-stopfailure'], {});
  assert.equal(r.status, 0, `hook must never fail a Claude turn: ${r.stderr}`);
  assert.equal(r.stderr, '', 'hook must not spray errors into the agent turn');
});

test('_monitor and _resumer with missing src/ exit 0 quietly', () => {
  for (const args of [['_monitor', 'tmux', '', '%1', 'claude', 'lease'], ['_resumer']]) {
    const r = run(args);
    assert.equal(r.status, 0, `${args[0]} must exit 0, got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /MODULE_NOT_FOUND|Cannot find module/);
  }
});

test('daemon with missing src/ exits 0 quietly (launchd KeepAlive crash-loop guard)', () => {
  const r = run(['daemon']);
  assert.equal(r.status, 0, `daemon must exit 0, got ${r.status}: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /MODULE_NOT_FOUND|Cannot find module/);
});

test('a healthy install is unaffected: help still routes normally', () => {
  const r = spawnSync(process.execPath, [REAL_BIN, 'help'], {
    encoding: 'utf-8',
    env: { ...process.env, UNSNOOZE_STATE_DIR: join(DIR, 'state'), UNSNOOZE_ACTIVE: '1' },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test('launch-exit notice is TTY-gated: piped stderr on a real launch stays clean', () => {
  // Healthy bin, outer path, tmux hidden from PATH → runUnwatched branch.
  // A pending newer version is cached, but stderr is a pipe (not a TTY), so
  // the notice must be suppressed — scripts and CI never see nag lines.
  const state = join(DIR, 'notice-state');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'update-check.json'),
    JSON.stringify({ lastCheckedAt: Date.now(), latest: '999.0.0' }));
  const r = spawnSync(process.execPath, [REAL_BIN, '_run', 'claude', 'ping'], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',                       // no tmux/zellij anywhere
      UNSNOOZE_STATE_DIR: state,
      UNSNOOZE_CLAUDE_BIN: '/bin/echo',
      TMUX: '', ZELLIJ: '', UNSNOOZE_ACTIVE: '',
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'ping\n');
  assert.doesNotMatch(r.stderr, /is available/, 'non-TTY stderr must never carry the notice');
});
