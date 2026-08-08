// Version-skew guard: a long-lived daemon whose loaded code no longer matches
// the on-disk package must exit cleanly so launchd/systemd restart it on
// fresh code (the "zombie daemon running deleted code" failure mode).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-skew-'));
process.env.UNSNOOZE_STATE_DIR = join(DIR, 'state');

const { hasVersionSkew, restartOnVersionSkew, daemonSkewAction, PKG_VERSION } = await import('../src/update-check.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

function writePkg(version) {
  writeFileSync(join(DIR, 'package.json'), JSON.stringify({ name: 'unsnooze', version }));
  return DIR;
}

test('no skew when disk version matches the loaded version', () => {
  assert.equal(hasVersionSkew({ root: writePkg(PKG_VERSION) }), false);
});

test('skew when the on-disk package is any different version', () => {
  assert.equal(hasVersionSkew({ root: writePkg('999.0.0') }), true);
  assert.equal(hasVersionSkew({ root: writePkg('0.0.1') }), true);
});

test('missing or unreadable package.json is NOT skew (mid-upgrade window)', () => {
  // While npm swaps files out, package.json may briefly not exist; exiting
  // then would race the installer. Only a *different, readable* version is
  // proof the upgrade finished.
  assert.equal(hasVersionSkew({ root: join(DIR, 'nonexistent') }), false);
  writeFileSync(join(DIR, 'package.json'), '{ not json');
  assert.equal(hasVersionSkew({ root: DIR }), false);
});

test('defaults read the real package root and therefore report no skew', () => {
  assert.equal(hasVersionSkew(), false);
});

// --- restartOnVersionSkew: hand-off for processes with no supervisor --------
// The daemon can just exit (launchd/systemd respawn it). Monitors and
// transient resumers have nobody to restart them, so they must spawn their
// own replacement on fresh code and only then stand down.

function spy(result) {
  const calls = [];
  const fn = (...args) => { calls.push(args); if (result instanceof Error) throw result; return result; };
  fn.calls = calls;
  return fn;
}

// This test file itself is a path that certainly exists — a stand-in for an
// intact install. Happy-path defaults so each test overrides only its subject.
const REAL_BIN = fileURLToPath(import.meta.url);
const opts = (over = {}) => ({
  args: ['_monitor'], skewed: () => true, binPath: REAL_BIN,
  alive: () => true, confirmDelayMs: 0, ...over,
});

test('no skew: nothing is spawned and the caller keeps running', async () => {
  const spawner = spy(4242);
  assert.equal(await restartOnVersionSkew(opts({ spawner, skewed: () => false })), false);
  assert.equal(spawner.calls.length, 0);
});

test('skew: spawns the replacement with the exact argv and env, then tells the caller to stand down', async () => {
  const spawner = spy(4242);
  assert.equal(await restartOnVersionSkew(opts({
    args: ['_monitor', 'tmux', '', '%0', 'claude', 'lease-1'],
    env: { UNSNOOZE_CWD: '/home/jamin/proj' }, spawner,
  })), true);
  assert.equal(spawner.calls.length, 1);
  assert.deepEqual(spawner.calls[0][0], ['_monitor', 'tmux', '', '%0', 'claude', 'lease-1']);
  assert.deepEqual(spawner.calls[0][1], { UNSNOOZE_CWD: '/home/jamin/proj' });
});

test('spawn throwing keeps the caller alive — a stale watcher beats no watcher', async () => {
  const spawner = spy(new Error('ENOENT'));
  const lines = [];
  assert.equal(await restartOnVersionSkew(opts({ spawner, log: m => lines.push(m) })), false);
  assert.equal(spawner.calls.length, 1);
  assert.match(lines.join('\n'), /ENOENT/);
});

test('a spawn that yields no pid is treated as failure, not hand-off', async () => {
  for (const bad of [undefined, null, 0, NaN, -1]) {
    const spawner = spy(bad);
    assert.equal(await restartOnVersionSkew(opts({ spawner })), false,
      `pid ${String(bad)} must not count as a successful hand-off`);
  }
});

test('every argument reaching the spawner is a string (spawn rejects null argv entries)', async () => {
  const spawner = spy(7);
  await restartOnVersionSkew(opts({ args: ['_monitor', 'tmux', '', '%0', 'claude', ''], spawner }));
  for (const arg of spawner.calls[0][0]) assert.equal(typeof arg, 'string');
});

// --- proving the replacement is real ---------------------------------------
// spawn() resolves the NODE BINARY, not the script, so a package mid-swap
// yields a live-looking pid for a child that is already dead:
//   spawn(node, ["/gone/unsnooze.js"]) -> pid 34940, no 'error' event
// Standing down on that pid leaves no watcher at all — the exact outcome the
// "stale beats none" rule exists to prevent.

test('a missing bin is never handed off to — the package is mid-swap', async () => {
  const spawner = spy(4242);
  const lines = [];
  assert.equal(await restartOnVersionSkew(opts({
    spawner, binPath: '/tmp/unsnooze-definitely-not-here/bin/unsnooze.js', log: m => lines.push(m),
  })), false);
  assert.equal(spawner.calls.length, 0, 'nothing is spawned into a half-installed tree');
  assert.match(lines.join('\n'), /missing|upgrade/i);
});

test('beforeSpawn does not run when the bin is missing — no giving up a lock for a hand-off that cannot happen', async () => {
  const beforeSpawn = spy();
  await restartOnVersionSkew(opts({
    spawner: spy(4242), binPath: '/tmp/unsnooze-definitely-not-here/bin/unsnooze.js', beforeSpawn,
  }));
  assert.equal(beforeSpawn.calls.length, 0);
});

test('beforeSpawn runs after skew is confirmed and immediately before the spawn', async () => {
  const order = [];
  await restartOnVersionSkew(opts({
    skewed: () => { order.push('skewed'); return true; },
    beforeSpawn: () => order.push('beforeSpawn'),
    spawner: (...a) => { order.push('spawn'); return 4242; },
  }));
  assert.deepEqual(order, ['skewed', 'beforeSpawn', 'spawn']);
});

test('beforeSpawn does not run when there is no skew', async () => {
  const beforeSpawn = spy();
  await restartOnVersionSkew(opts({ spawner: spy(1), skewed: () => false, beforeSpawn }));
  assert.equal(beforeSpawn.calls.length, 0);
});

test('a replacement that died on startup is not a hand-off', async () => {
  const lines = [];
  const checked = [];
  assert.equal(await restartOnVersionSkew(opts({
    spawner: spy(4242),
    alive: pid => { checked.push(pid); return false; },
    log: m => lines.push(m),
  })), false, 'the caller keeps running rather than standing down onto a corpse');
  assert.deepEqual(checked, [4242], 'the spawned pid is the one checked');
  assert.match(lines.join('\n'), /4242/);
});

test('liveness is checked only after the confirm delay has elapsed', async () => {
  const seq = [];
  await restartOnVersionSkew(opts({
    spawner: spy(4242), confirmDelayMs: 25,
    sleep: async ms => { seq.push(`slept:${ms}`); },
    alive: () => { seq.push('alive?'); return true; },
  }));
  assert.deepEqual(seq, ['slept:25', 'alive?']);
});

// --- daemon skew policy -----------------------------------------------------
// The daemon keeps its 15-minute cadence (a deliberate hedge against
// restarting into a half-installed package), but what it DOES on skew now
// depends on whether anything would bring it back.

test('a supervised daemon restarts on skew — the supervisor owns the respawn', () => {
  assert.equal(daemonSkewAction({ skewed: true, supervised: true }), 'restart');
  assert.equal(daemonSkewAction({ skewed: true, supervised: true, alreadyWarned: true }), 'restart',
    'warning state is irrelevant when a supervisor exists');
});

test('an unsupervised daemon warns instead of exiting into nothing', () => {
  assert.equal(daemonSkewAction({ skewed: true, supervised: false }), 'warn');
});

test('the unsupervised warning fires once, not every 15 minutes forever', () => {
  assert.equal(daemonSkewAction({ skewed: true, supervised: false, alreadyWarned: true }), 'none');
});

test('no skew means no action, supervised or not', () => {
  for (const supervised of [true, false]) {
    assert.equal(daemonSkewAction({ skewed: false, supervised }), 'none');
  }
});
