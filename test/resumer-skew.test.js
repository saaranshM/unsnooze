// Resumer version-skew hand-off (issue #8, second half).
//
// The transient resumer is spawned at the stop and lives until resetAt —
// routinely hours (the reporter's ran 15:21→17:50). It is the process that
// actually sends the wake, so running deleted code there is strictly worse
// than in the monitor. It has no supervisor either.
//
// The singleton lock makes the hand-off order load-bearing: a replacement that
// starts while the old process still holds the lock sees a live holder, logs
// "another resumer is running — exiting", and dies — leaving nothing at all.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-resumer-skew-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');

const { runResumer, acquireSingleton, releaseSingleton } = await import('../src/resumer.js');
const { upsertSession, readState, updateState } = await import('../src/state.js');
const { RESUMER_LOCK } = await import('../src/config.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

function reset() {
  releaseSingleton();
  try { rmSync(RESUMER_LOCK, { force: true }); } catch { /* gone */ }
  updateState(state => { state.sessions = {}; state.resumerPid = null; return state; });
}

// A pending stop far in the future: the loop has real work to wait for, so
// returning 0 can only mean the skew hand-off fired — never "nothing to do".
function seedPendingStop() {
  upsertSession({
    sessionId: '7a921b11-beae-4566-bdf0-cd3f18c4b2e2',
    cwd: '/home/jamin/proj/sysadmin', pane: '%0', mux: 'tmux', paneOwner: null,
    agent: 'claude', status: 'stopped', limitType: '5h', detectedVia: 'hook',
    detectedAt: Date.now(), resetAt: Date.now() + 3 * 3_600_000,
    resetSource: 'absolute', attempts: 0,
  });
}

// A rescue signal so a regression fails on an assertion in milliseconds
// instead of hanging until the test-runner timeout. With the hand-off working
// the resumer returns long before this fires.
function rescue(ms = 150) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

// The hand-off confirms the replacement survived startup, so a "successful"
// spawn must report a genuinely live pid — our own stands in for a healthy child.
function spawnSpy(pid = process.pid) {
  const calls = [];
  const fn = (...a) => {
    // Snapshot the lock exactly as the replacement would find it.
    calls.push({ args: a, lockAtSpawn: existsSync(RESUMER_LOCK) ? readFileSync(RESUMER_LOCK, 'utf-8') : null });
    if (pid instanceof Error) throw pid;
    return pid;
  };
  fn.calls = calls;
  return fn;
}

test('a starting resumer records the version it is running', async () => {
  reset();
  const { PKG_VERSION } = await import('../src/update-check.js');
  await runResumer({ pollInterval: 5, spawner: spawnSpy(), versionSkewed: () => false });

  const logged = readFileSync(join(DIR, 'unsnooze.log'), 'utf-8');
  const startLine = logged.split('\n').filter(l => l.includes('resumer started')).pop();
  assert.ok(startLine, 'the start line was written');
  assert.match(startLine, new RegExp(PKG_VERSION.replace(/\./g, '\\.')));
});

test('transient resumer under skew spawns a replacement and exits', async () => {
  reset();
  seedPendingStop();
  const spawner = spawnSpy();
  const r = rescue();

  const code = await runResumer({
    pollInterval: 5, signal: r.signal, spawner, versionSkewed: () => true,
  });
  r.done();

  assert.equal(code, 0);
  assert.equal(spawner.calls.length, 1, 'exactly one replacement');
  assert.deepEqual(spawner.calls[0].args[0], ['_resumer']);
});

test('the lock is released BEFORE the replacement starts, or the child would exit on sight', async () => {
  reset();
  seedPendingStop();
  const spawner = spawnSpy();
  const r = rescue();

  await runResumer({ pollInterval: 5, signal: r.signal, spawner, versionSkewed: () => true });
  r.done();

  assert.equal(spawner.calls.length, 1, 'a replacement was spawned at all');
  const held = spawner.calls[0].lockAtSpawn;
  assert.notEqual(held, String(process.pid),
    'the outgoing resumer must not still own the lock when its replacement starts');
  assert.equal(readState().resumerPid, null, 'and it must not still claim resumerPid');
});

test('no skew: the resumer keeps the lock and does not spawn anything', async () => {
  reset();
  const spawner = spawnSpy();

  // Empty ledger → the loop exits on its own ("no pending sessions").
  const code = await runResumer({ pollInterval: 5, spawner, versionSkewed: () => false });

  assert.equal(code, 0);
  assert.equal(spawner.calls.length, 0);
});

test('a replacement that died on startup gives the lock back', async () => {
  reset();
  seedPendingStop();
  const spawner = spawnSpy(999999999);          // spawned, then immediately dead
  const ctrl = new AbortController();
  // Must outlast the hand-off's confirm delay, or the loop aborts mid-check
  // and never reaches the tick that proves the lock came back.
  const timer = setTimeout(() => ctrl.abort(), 900);
  const lockAtTick = [];
  const versionSkewed = () => {
    lockAtTick.push(existsSync(RESUMER_LOCK) ? readFileSync(RESUMER_LOCK, 'utf-8') : null);
    return lockAtTick.length === 1;
  };

  const code = await runResumer({ pollInterval: 5, signal: ctrl.signal, spawner, versionSkewed });
  clearTimeout(timer);

  assert.equal(code, 0);
  assert.equal(spawner.calls.length, 1);
  assert.ok(lockAtTick.length > 1, 'the resumer kept running rather than standing down onto a corpse');
  assert.equal(lockAtTick[1], String(process.pid), 'and reclaimed the lock it released');
});

test('a pre-flight refusal never releases the lock in the first place', async () => {
  reset();
  seedPendingStop();
  const spawner = spawnSpy();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 200);
  const lockAtTick = [];
  const versionSkewed = () => {
    lockAtTick.push(existsSync(RESUMER_LOCK) ? readFileSync(RESUMER_LOCK, 'utf-8') : null);
    return true;                                 // skewed on every tick
  };

  await runResumer({
    pollInterval: 5, signal: ctrl.signal, spawner, versionSkewed,
    handoffBin: '/tmp/unsnooze-definitely-not-here/bin/unsnooze.js',
  });
  clearTimeout(timer);

  assert.equal(spawner.calls.length, 0, 'nothing spawned into a half-installed tree');
  assert.ok(lockAtTick.length > 1, 'the resumer kept running');
  assert.ok(lockAtTick.every(l => l === String(process.pid)),
    'the lock stayed ours throughout — never released for an impossible hand-off');
});

test('a failed hand-off takes the lock back rather than running unlocked', async () => {
  reset();
  seedPendingStop();
  const spawner = spawnSpy(new Error('ENOENT'));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 150);

  // The skew check runs once per tick, so it doubles as a probe: snapshot who
  // owns the lock at the top of every tick. Skewed on tick 1 only — the spawn
  // throws, and tick 2 must find the lock back in our name.
  const lockAtTick = [];
  const versionSkewed = () => {
    lockAtTick.push(existsSync(RESUMER_LOCK) ? readFileSync(RESUMER_LOCK, 'utf-8') : null);
    return lockAtTick.length === 1;
  };

  const code = await runResumer({ pollInterval: 5, signal: ctrl.signal, spawner, versionSkewed });
  clearTimeout(timer);

  assert.equal(code, 0);
  assert.equal(spawner.calls.length, 1, 'it tried exactly once');
  assert.ok(lockAtTick.length > 1, 'the loop kept running after the failed hand-off');
  assert.equal(lockAtTick[1], String(process.pid), 'the lock was reclaimed, not abandoned');
});

test('the daemon does not self-respawn — launchd/systemd own its restart', async () => {
  reset();
  seedPendingStop();
  const spawner = spawnSpy();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120);

  const code = await runResumer({
    pollInterval: 5, persistent: true, signal: ctrl.signal,
    spawner, versionSkewed: () => true,
  });
  clearTimeout(timer);

  assert.equal(code, 0);
  assert.equal(spawner.calls.length, 0,
    'a supervised process must exit via its supervisor, not fork a rival');
});

test('after the hand-off the lock is free for the replacement to take', async () => {
  reset();
  seedPendingStop();
  const r = rescue();
  await runResumer({ pollInterval: 5, signal: r.signal, spawner: spawnSpy(), versionSkewed: () => true });
  r.done();

  assert.equal(acquireSingleton(), true, 'a fresh resumer can acquire immediately');
  releaseSingleton();
});
