// Monitor version-skew hand-off (issue #8 regression).
//
// A monitor is spawned once per pane by the launcher and lives as long as the
// agent does. `npm i -g unsnooze` replaces the package on disk but cannot
// touch a running process's already-loaded modules, and no supervisor watches
// a monitor. Reported evidence: a pane launched 2026-08-02 was still emitting
// pre-1.14.2 log lines on 2026-08-07 — five days and one upgrade later — and
// so still completed limit stops with the deleted "banner cleared → resumed"
// rule while the fixed code sat unused on disk.
//
// The monitor must therefore hand off to a replacement on fresh code itself.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-monitor-skew-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');

const { createMonitor } = await import('../src/monitor.js');
const { readState } = await import('../src/state.js');
const { EVENTS_DIR } = await import('../src/config.js');
const { addressHash, writeLease } = await import('../src/lease.js');
const { monitorSpawnArgs } = await import('../src/spawn.js');

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

// The launcher's exact spawn shape, mirrored here so a drift in either side
// fails loudly: src/launcher.js spawns
//   ['_monitor', mux.name, paneOwner || '', pane, agent.id, leaseId]
// with env { UNSNOOZE_CWD: process.cwd() }.
const CWD = '/home/jamin/proj/sysadmin';

// The hand-off now confirms the replacement survived startup, so a "successful"
// spawn must report a pid that is genuinely alive. Our own pid is the simplest
// honest stand-in for a healthy child.
function spawnSpy(pid = process.pid) {
  const calls = [];
  const fn = (...a) => { calls.push(a); if (pid instanceof Error) throw pid; return pid; };
  fn.calls = calls;
  return fn;
}

function fakeMux(script = {}) {
  return {
    paneAlive: async () => script.alive ?? true,
    capturePane: async () => script.text ?? '> idle',
    capturePaneVisible: async () => script.text ?? '> idle',
    sendText: async () => {},
    sendKey: async () => {},
    sessionForPane: async () => '0',
  };
}

function build({ skewed = () => true, spawner = spawnSpy(), script = {}, leaseId = 'lease-1', pane = '%0' } = {}) {
  const monitor = createMonitor({
    muxName: 'tmux', paneOwner: null, pane, leaseId, cwd: CWD,
    mux: fakeMux(script), spawner, versionSkewed: skewed,
  });
  return { monitor, spawner };
}

function markerPath(pane) {
  return join(EVENTS_DIR, `${addressHash({ mux: 'tmux', paneOwner: null, pane })}.json`);
}

function seedLease(pane, leaseId) {
  writeLease({ leaseId, mux: 'tmux', paneOwner: null, pane, pid: process.pid });
}

// The replacement must be launched exactly the way the launcher launches a
// monitor. Both call monitorSpawnArgs, so the shapes cannot drift apart; these
// pin the shape itself, including the empty-string holes for absent values.
// Issue #8 took a release to diagnose because nothing in the log said which
// build each watcher was running — the only tell was a log line that happened
// to have been deleted in the fix. Stamp the version at startup so a pasted
// log answers "is this process even on the new code?" immediately.
test('a starting monitor records the version it is running', async () => {
  const { PKG_VERSION } = await import('../src/update-check.js');
  const monitor = createMonitor({
    muxName: 'tmux', paneOwner: null, pane: '%90', leaseId: null, cwd: CWD,
    mux: fakeMux({ alive: false }), spawner: spawnSpy(), versionSkewed: () => false,
  });
  await monitor.run();

  const logged = readFileSync(join(DIR, 'unsnooze.log'), 'utf-8');
  const startLine = logged.split('\n').filter(l => l.includes('monitor started for pane %90')).pop();
  assert.ok(startLine, 'the start line was written');
  assert.match(startLine, new RegExp(PKG_VERSION.replace(/\./g, '\\.')));
});

test('monitorSpawnArgs builds the _monitor argv, coercing absent values to ""', () => {
  assert.deepEqual(
    monitorSpawnArgs({ muxName: 'tmux', paneOwner: null, pane: '%0', agentId: 'claude', leaseId: 'l1' }),
    ['_monitor', 'tmux', '', '%0', 'claude', 'l1'],
  );
  assert.deepEqual(
    monitorSpawnArgs({ muxName: 'zellij', paneOwner: 'sess', pane: '3', agentId: 'codex', leaseId: null }),
    ['_monitor', 'zellij', 'sess', '3', 'codex', ''],
  );
  for (const arg of monitorSpawnArgs({ muxName: 'tmux', pane: '%0', agentId: 'claude' })) {
    assert.equal(typeof arg, 'string', 'child_process rejects null/undefined argv entries');
  }
});

test('skew: hands off to a fresh monitor with the launcher argv, and stops ticking', async () => {
  seedLease('%0', 'lease-1');
  const { monitor, spawner } = build();
  await monitor._tick();

  assert.equal(spawner.calls.length, 1, 'exactly one replacement spawned');
  assert.deepEqual(spawner.calls[0][0], ['_monitor', 'tmux', '', '%0', 'claude', 'lease-1']);
  assert.deepEqual(spawner.calls[0][1], { UNSNOOZE_CWD: CWD });
  assert.equal(monitor._running, false, 'old monitor stands down after the hand-off');
});

test('no skew: nothing is spawned and the monitor keeps ticking', async () => {
  seedLease('%1', 'lease-1');
  const { monitor, spawner } = build({ skewed: () => false, pane: '%1' });
  await monitor._tick();

  assert.equal(spawner.calls.length, 0);
  assert.equal(monitor._running, true);
});

test('a null leaseId reaches the spawner as "" — child_process rejects null argv entries', async () => {
  const { monitor, spawner } = build({ leaseId: null, pane: '%2' });
  await monitor._tick();

  assert.equal(spawner.calls.length, 1);
  for (const arg of spawner.calls[0][0]) assert.equal(typeof arg, 'string');
  assert.equal(spawner.calls[0][0][5], '');
  assert.equal(monitor._running, false);
});

test('a failed hand-off leaves the monitor running — never trade a stale watcher for none', async () => {
  seedLease('%3', 'lease-1');
  const { monitor, spawner } = build({ spawner: spawnSpy(new Error('ENOENT')), pane: '%3' });
  await monitor._tick();

  assert.equal(spawner.calls.length, 1);
  assert.equal(monitor._running, true, 'monitor keeps watching and retries next tick');
});

test('a hand-off that returns no pid also leaves the monitor running', async () => {
  seedLease('%4', 'lease-1');
  const { monitor, spawner } = build({ spawner: spawnSpy(0), pane: '%4' });
  await monitor._tick();

  assert.equal(monitor._running, true);
});

test('a replacement that died on startup leaves the monitor running', async () => {
  // The real hazard, end to end: spawn() resolves the node binary, so a broken
  // or half-installed tree still yields a pid. Standing down on it would leave
  // the pane with no watcher at all.
  seedLease('%10', 'lease-1');
  const spawner = spawnSpy(999999999);          // far above any real pid
  const monitor = createMonitor({
    muxName: 'tmux', paneOwner: null, pane: '%10', leaseId: 'lease-1', cwd: CWD,
    mux: fakeMux(), spawner, versionSkewed: () => true,
  });
  await monitor._tick();

  assert.equal(spawner.calls.length, 1, 'it tried');
  assert.equal(monitor._running, true, 'and kept watching when the child did not survive');
});

test('a missing install tree is never handed off to — the monitor keeps watching', async () => {
  seedLease('%11', 'lease-1');
  const spawner = spawnSpy();
  const monitor = createMonitor({
    muxName: 'tmux', paneOwner: null, pane: '%11', leaseId: 'lease-1', cwd: CWD,
    mux: fakeMux(), spawner, versionSkewed: () => true,
    handoffBin: '/tmp/unsnooze-definitely-not-here/bin/unsnooze.js',
  });
  await monitor._tick();

  assert.equal(spawner.calls.length, 0, 'nothing spawned into a half-installed tree');
  assert.equal(monitor._running, true);
});

test('dead pane exits without spawning a replacement for a pane nobody is using', async () => {
  const { monitor, spawner } = build({ script: { alive: false }, pane: '%5' });
  await monitor._tick();

  assert.equal(spawner.calls.length, 0, 'no orphan monitor for a dead pane');
  assert.equal(monitor._running, false);
});

test('a vanished lease exits without spawning a replacement, even under skew', async () => {
  // Ordering guarantee: the agent-gone checks run BEFORE the skew check, so an
  // upgrade landing right as the agent exits does not leave a monitor watching
  // a pane that now hosts the user's plain shell.
  const pane = '%6';
  seedLease(pane, 'lease-6');
  let skewed = false;
  const spawner = spawnSpy();
  const monitor = createMonitor({
    muxName: 'tmux', paneOwner: null, pane, leaseId: 'lease-6', cwd: CWD,
    mux: fakeMux(), spawner, versionSkewed: () => skewed,
  });

  await monitor._tick();                     // lease present → leaseSeen
  assert.equal(monitor._running, true);
  assert.equal(spawner.calls.length, 0);

  rmSync(join(DIR, 'leases'), { recursive: true, force: true });
  skewed = true;
  await monitor._tick();

  assert.equal(spawner.calls.length, 0, 'agent is gone — nothing left to hand off to');
  assert.equal(monitor._running, false);
});

test('the pending overload marker survives the hand-off — it is not consumed then dropped', async () => {
  const pane = '%7';
  seedLease(pane, 'lease-1');
  mkdirSync(EVENTS_DIR, { recursive: true });
  writeFileSync(markerPath(pane), JSON.stringify({ kind: 'overload', at: Date.now() }));

  const { monitor, spawner } = build({ pane });
  await monitor._tick();

  assert.equal(spawner.calls.length, 1);
  assert.equal(existsSync(markerPath(pane)), true,
    'the replacement monitor must still find the event the old one never handled');
});

test('skew during a tracked stop hands off instead of ruling on the record', async () => {
  // The reported failure: stale code completing a stop it had no evidence for.
  // A skewed monitor must not reach any status decision at all.
  const pane = '%8';
  seedLease(pane, 'lease-1');
  const spawner = spawnSpy();
  const monitor = createMonitor({
    muxName: 'tmux', paneOwner: null, pane, leaseId: 'lease-1', cwd: CWD,
    mux: fakeMux({ text: '> idle, no banner' }), spawner, versionSkewed: () => true,
  });
  await monitor._tick();

  assert.equal(spawner.calls.length, 1);
  assert.equal(monitor._running, false);
  assert.deepEqual(Object.values(readState().sessions).filter(s => s.pane === pane), [],
    'no record was created or mutated by the skewed monitor');
});
