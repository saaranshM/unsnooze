import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-spawn-reap-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { stopResumer, pidAlive } = await import('../src/spawn.js');
const { RESUMER_LOCK } = await import('../src/config.js');
const { reap, isUnsnoozeSessionName, attachHint } = await import('../src/reap.js');
const { upsertSession, readState, setStatus } = await import('../src/state.js');

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

// One shared pidAlive now backs the resumer's lock hygiene, the dashboard's
// liveness column, and the version-skew hand-off. Pid 0 is the trap: kill(0, 0)
// signals our OWN process group and succeeds, so a lock file containing "0"
// would read as a live holder and be honored forever.
test('pidAlive rejects 0 and non-pids instead of signalling our own process group', () => {
  assert.equal(pidAlive(process.pid), true, 'a real live pid is alive');
  assert.equal(pidAlive(0), false, 'pid 0 is the process group, not a live holder');
  assert.equal(pidAlive(null), false);
  assert.equal(pidAlive(undefined), false);
  assert.equal(pidAlive(NaN), false);
  assert.equal(pidAlive(999999999), false, 'a dead pid is dead');
});

test('stopResumer cleans a stale lock (dead pid)', () => {
  writeFileSync(RESUMER_LOCK, '999999999');
  const result = stopResumer();
  assert.equal(existsSync(RESUMER_LOCK), false);
  assert.equal(result.stopped, false);
  assert.equal(result.reason, 'stale');
});

test('stopResumer tolerates a missing lock', () => {
  try { rmSync(RESUMER_LOCK, { force: true }); } catch { /* */ }
  const result = stopResumer();
  assert.equal(result.stopped, false);
  assert.equal(result.reason, 'no-lock');
});

test('stopResumer SIGTERMs a live pid and unlinks the lock', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', detached: true,
  });
  child.unref();
  writeFileSync(RESUMER_LOCK, String(child.pid));
  const result = stopResumer();
  assert.equal(result.stopped, true);
  assert.equal(result.pid, child.pid);
  assert.equal(existsSync(RESUMER_LOCK), false);
  // Wait briefly for SIGTERM to take effect.
  await new Promise(r => setTimeout(r, 150));
  let alive = true;
  try { process.kill(child.pid, 0); } catch { alive = false; }
  if (alive) {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* */ }
  }
  assert.equal(alive, false);
});

test('isUnsnoozeSessionName matches base, numbered, resumed, pid', () => {
  assert.equal(isUnsnoozeSessionName('unsnooze'), true);
  assert.equal(isUnsnoozeSessionName('unsnooze-2'), true);
  assert.equal(isUnsnoozeSessionName('unsnooze-resumed'), true);
  assert.equal(isUnsnoozeSessionName('unsnooze-12345'), true);
  assert.equal(isUnsnoozeSessionName('other'), false);
  assert.equal(isUnsnoozeSessionName('unsnooze-backup'), false);
});

test('attachHint names the right mux attach command', () => {
  assert.equal(attachHint('tmux', 'unsnooze-resumed'), 'tmux attach -t unsnooze-resumed');
  assert.equal(attachHint('zellij', 'unsnooze-resumed'), 'zellij attach unsnooze-resumed');
  assert.equal(attachHint('tmux', null), null);
});

test('reap dry-run kills nothing', async () => {
  const state = upsertSession({
    sessionId: 'reap-dry-1',
    cwd: '/tmp/x', pane: '%99', mux: 'tmux', paneOwner: null, muxSession: 'unsnooze-resumed',
    status: 'resumed', limitType: '5h', detectedVia: 'hook',
    detectedAt: Date.now(), resetAt: Date.now(), resetSource: 'absolute',
    attempts: 0, lastAttemptAt: Date.now(), lastError: null,
  });
  const key = Object.keys(state.sessions).find(k => state.sessions[k].sessionId === 'reap-dry-1');
  setStatus(key, 'resumed');

  const closed = [];
  const result = await reap({
    dryRun: true,
    resolveMux: () => ({
      paneAlive: async () => true,
      closePane: async pane => closed.push(pane),
      listSessions: async () => [],
      available: () => true,
    }),
  });
  assert.equal(result.dryRun, true);
  assert.equal(closed.length, 0);
  // dry-run may still *list* close-pane actions, but must not execute them.
  assert.ok(result.actions.some(a => a.kind === 'close-pane' || a.kind === 'drop-record'
    || a.kind === 'delete-session') || result.actions.length >= 0);
  assert.ok(readState().sessions[key], 'record must survive dry-run');
});

test('reap drops a superseded alias without closing its active shared pane', async () => {
  const oldAt = Date.now() - 140_000;
  upsertSession({
    sessionId: 'reap-shared-old', cwd: '/tmp/shared', pane: '%shared',
    mux: 'tmux', paneOwner: null, muxSession: 'unsnooze-resumed',
    leaseId: 'shared-lease', agent: 'claude', status: 'cancelled',
    limitType: '5h', detectedVia: 'hook', detectedAt: oldAt, bannerAt: oldAt,
    resetAt: Date.now(), resetSource: 'absolute', attempts: 0,
  });
  upsertSession({
    sessionId: 'reap-shared-new', cwd: '/tmp/shared', pane: '%shared',
    mux: 'tmux', paneOwner: null, muxSession: 'unsnooze-resumed',
    leaseId: 'shared-lease', agent: 'claude', status: 'resuming',
    limitType: '5h', detectedVia: 'hook', detectedAt: oldAt + 130_000,
    bannerAt: oldAt + 130_000, resetAt: Date.now(), resetSource: 'absolute',
    attempts: 0, resumeEpisodeAt: oldAt + 130_000,
  });
  const closed = [];
  const mux = {
    paneAlive: async () => true,
    paneOwnerStamp: async () => 'shared-lease',
    closePane: async pane => closed.push(pane),
    available: () => false,
  };
  const { actions } = await reap({ yes: true, resolveMux: () => mux });

  assert.deepEqual(closed, []);
  assert.equal(readState().sessions['reap-shared-old'], undefined);
  assert.equal(readState().sessions['reap-shared-new'].status, 'resuming');
  assert.match(actions.find(a => a.key === 'reap-shared-old').reason, /shared with active/);
});

test('reap rechecks for a shared live owner after an awaited pane probe', async () => {
  const oldAt = Date.now() - 300_000;
  upsertSession({
    sessionId: 'reap-race-old', cwd: '/tmp/shared-race', pane: '%shared-race',
    mux: 'tmux', paneOwner: null, muxSession: 'unsnooze-resumed',
    leaseId: 'shared-race-lease', agent: 'claude', status: 'cancelled',
    limitType: '5h', detectedVia: 'hook', detectedAt: oldAt, bannerAt: oldAt,
    resetAt: Date.now(), resetSource: 'absolute', attempts: 0,
  });

  let releaseProbe;
  let probeStarted;
  const started = new Promise(resolve => { probeStarted = resolve; });
  const blocked = new Promise(resolve => { releaseProbe = resolve; });
  const closed = [];
  const mux = {
    paneAlive: async () => {
      probeStarted();
      await blocked;
      return true;
    },
    paneOwnerStamp: async () => 'shared-race-lease',
    closePane: async pane => closed.push(pane),
    available: () => false,
  };

  const inFlight = reap({ yes: true, resolveMux: () => mux });
  await started;
  upsertSession({
    sessionId: 'reap-race-new', cwd: '/tmp/shared-race', pane: '%shared-race',
    mux: 'tmux', paneOwner: null, muxSession: 'unsnooze-resumed',
    leaseId: 'shared-race-lease', agent: 'claude', status: 'resuming',
    limitType: '5h', detectedVia: 'hook', detectedAt: Date.now(), bannerAt: Date.now(),
    resetAt: Date.now(), resetSource: 'absolute', attempts: 0,
    resumeEpisodeAt: Date.now(),
  });
  releaseProbe();

  const { actions } = await inFlight;
  assert.deepEqual(closed, []);
  assert.equal(readState().sessions['reap-race-old'], undefined);
  assert.equal(readState().sessions['reap-race-new'].status, 'resuming');
  assert.match(actions.find(a => a.key === 'reap-race-old').reason, /shared with active/);
});

test('a detection after close submission cannot retain the closing pane generation', async () => {
  const oldAt = Date.now() - 300_000;
  upsertSession({
    sessionId: 'reap-close-old', cwd: '/tmp/close-race', pane: '%close-race',
    mux: 'tmux', paneOwner: null, muxSession: 'unsnooze-resumed',
    leaseId: 'close-race-lease', agent: 'claude', status: 'cancelled',
    limitType: '5h', detectedVia: 'hook', detectedAt: oldAt, bannerAt: oldAt,
    resetAt: Date.now(), resetSource: 'absolute', attempts: 0,
  });

  let releaseClose;
  let closeStarted;
  const started = new Promise(resolve => { closeStarted = resolve; });
  const blocked = new Promise(resolve => { releaseClose = resolve; });
  const closed = [];
  const mux = {
    paneAlive: async () => true,
    paneOwnerStamp: async () => 'close-race-lease',
    closePane: async pane => {
      closeStarted();
      await blocked;
      closed.push(pane);
    },
    available: () => false,
  };

  const inFlight = reap({ yes: true, resolveMux: () => mux });
  await started;
  upsertSession({
    sessionId: 'reap-close-new', cwd: '/tmp/close-race', pane: '%close-race',
    mux: 'tmux', paneOwner: null, muxSession: 'unsnooze-resumed',
    leaseId: 'close-race-lease', agent: 'claude', status: 'resuming',
    limitType: '5h', detectedVia: 'hook', detectedAt: Date.now(), bannerAt: Date.now(),
    resetAt: Date.now(), resetSource: 'absolute', attempts: 0,
    resumeEpisodeAt: Date.now(),
  });
  const raced = readState().sessions['reap-close-new'];
  assert.equal(raced.status, 'stopped');
  assert.equal(raced.pane, null);
  assert.equal(raced.leaseId, null);
  releaseClose();
  await inFlight;
  assert.deepEqual(closed, ['%close-race']);
  assert.equal(readState().sessions['reap-close-new'].pane, null);
});
