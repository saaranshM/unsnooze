// F4 — pane identity & ownership. tmux pane ids are server-global and get
// RECYCLED: %0 dies, a fresh server/session mints %0 again for someone else's
// work. Every path that types into or closes a pane by id must first prove
// the pane is still the one unsnooze created:
//   layer 1: @unsnooze_owner pane option (survives agent exit, dies with pane)
//   layer 2: lease pid+birth match (proves the leased agent process is alive)
// Records without any lease (legacy/GUI) fall back to the old heuristics.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-pane-id-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';

const { createTmux } = await import('../src/multiplexers/tmux.js');
const { paneOwnedByRecord, writeLease, removeLease } = await import('../src/lease.js');
const { reap, autoReapIfEnabled } = await import('../src/reap.js');
const { dispatchOne } = await import('../src/resumer.js');
const { createMonitor } = await import('../src/monitor.js');
const { upsertSession, readState } = await import('../src/state.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

function fakeSpawner(respond = () => '') {
  const calls = [];
  const spawner = (file, args, options = {}) => {
    calls.push({ file, args, options });
    return respond(file, args, options);
  };
  spawner.calls = calls;
  return spawner;
}

let seedCounter = 0;
function seed(overrides = {}) {
  seedCounter += 1;
  const rec = {
    sessionId: `00000000-0000-4000-8000-${String(seedCounter).padStart(12, '0')}`,
    cwd: '/tmp/proj', pane: overrides.pane || `%${seedCounter}`, mux: 'tmux', paneOwner: null,
    status: 'stopped', limitType: '5h', detectedVia: 'hook',
    detectedAt: Date.now() - 3_600_000, resetAt: Date.now() - 1000,
    resetSource: 'absolute', attempts: 0,
    ...overrides,
  };
  const state = upsertSession(rec);
  return Object.values(state.sessions).find(s => s.sessionId === rec.sessionId);
}

// --- tmux stamp primitives ----------------------------------------------------

test('stampPaneOwner sets the @unsnooze_owner pane option', async () => {
  const spawner = fakeSpawner(() => '');
  const mux = createTmux({ spawner, env: {} });
  await mux.stampPaneOwner('%7', 'lease-abc');
  assert.deepEqual(spawner.calls.at(-1).args,
    ['set-option', '-p', '-t', '%7', '@unsnooze_owner', 'lease-abc']);
});

test('paneOwnerStamp reads the option back, blank/error → null', async () => {
  const mux1 = createTmux({ spawner: fakeSpawner(() => 'lease-abc\n'), env: {} });
  assert.equal(await mux1.paneOwnerStamp('%7'), 'lease-abc');
  const mux2 = createTmux({ spawner: fakeSpawner(() => '\n'), env: {} });
  assert.equal(await mux2.paneOwnerStamp('%7'), null);
  const mux3 = createTmux({ spawner: fakeSpawner(() => { throw new Error('gone'); }), env: {} });
  assert.equal(await mux3.paneOwnerStamp('%7'), null);
});

// --- ownership policy ----------------------------------------------------------

test('paneOwnedByRecord: matching stamp proves ownership even with a dead lease', async () => {
  const rec = { mux: 'tmux', paneOwner: null, pane: '%9', leaseId: 'L1', agent: 'claude' };
  const mux = { paneOwnerStamp: async () => 'L1', paneAlive: async () => true };
  assert.equal(await paneOwnedByRecord(rec, { mux }), true);
});

test('paneOwnedByRecord: a DIFFERENT stamp vetoes, whatever the lease says', async () => {
  const rec = { mux: 'tmux', paneOwner: null, pane: '%9', leaseId: 'L1', agent: 'claude' };
  const mux = { paneOwnerStamp: async () => 'someone-else', paneAlive: async () => true };
  assert.equal(await paneOwnedByRecord(rec, { mux, matchesLease: async () => true }), false);
});

test('paneOwnedByRecord: no stamp → lease decides; leased=true owns', async () => {
  const rec = { mux: 'tmux', paneOwner: null, pane: '%9', leaseId: 'L1', agent: 'claude' };
  const mux = { paneOwnerStamp: async () => null, paneAlive: async () => true };
  assert.equal(await paneOwnedByRecord(rec, { mux, matchesLease: async () => true }), true);
  assert.equal(await paneOwnedByRecord(rec, { mux, matchesLease: async () => false }), false,
    'record expected a lease and none matched → recycled pane');
});

test('paneOwnedByRecord: legacy record without leaseId → null (caller falls back)', async () => {
  const rec = { mux: 'tmux', paneOwner: null, pane: '%9', leaseId: null, agent: 'claude' };
  const mux = { paneOwnerStamp: async () => null, paneAlive: async () => true };
  assert.equal(await paneOwnedByRecord(rec, { mux }), null);
});

// --- reap enforcement -----------------------------------------------------------

test('reap --yes refuses to close a live pane whose stamp belongs to someone else', async () => {
  const rec = seed({ status: 'failed', leaseId: 'L-old' });
  const closed = [];
  const mux = {
    paneAlive: async () => true,
    paneOwnerStamp: async () => 'L-other',        // pane id recycled
    closePane: async p => closed.push(p),
    available: () => false, listSessions: async () => [],
  };
  const { actions } = await reap({ yes: true, resolveMux: () => mux });
  assert.equal(closed.length, 0, 'foreign pane must never be closed');
  const act = actions.find(a => a.key === rec.key);
  assert.equal(act.kind, 'drop-record', 'record is stale — drop it instead');
  assert.equal(readState().sessions[rec.key], undefined, 'stale record removed');
});

test('autoReapIfEnabled also drops instead of closing a recycled pane', async () => {
  process.env.UNSNOOZE_REAP_RESUMED = 'on';
  process.env.UNSNOOZE_REAP_IDLE_AFTER = '1';
  try {
    const rec = seed({ status: 'resumed', leaseId: 'L-old', lastAttemptAt: Date.now() - 10_000 });
    const closed = [];
    const mux = {
      paneAlive: async () => true,
      paneOwnerStamp: async () => 'L-other',
      closePane: async p => closed.push(p),
    };
    const n = await autoReapIfEnabled({ resolveMux: () => mux });
    assert.equal(n, 0);
    assert.equal(closed.length, 0);
    assert.equal(readState().sessions[rec.key], undefined, 'stale record removed');
  } finally {
    delete process.env.UNSNOOZE_REAP_RESUMED;
    delete process.env.UNSNOOZE_REAP_IDLE_AFTER;
  }
});

// --- dispatch (message injection) enforcement ------------------------------------

test('dispatchOne never types into a recycled pane: stamp mismatch vetoes foreground match', async () => {
  const rec = seed({ agent: 'claude', leaseId: 'L-mine' });
  const sent = [];
  const mux = {
    paneAlive: async () => true,
    capturePane: async () => '❯ ',                 // idle prompt — content looks owned
    paneCurrentCommand: async () => 'node',        // over-broad foreground match
    paneOwnerStamp: async () => 'L-other',         // …but the pane is someone else's
    sendText: async (p, t) => sent.push({ p, t }),
    newWindow: async () => ({ pane: '%99', paneOwner: null }),
    sessionExists: async () => false,
    stampPaneOwner: async () => {},
  };
  const result = await dispatchOne(rec, { mux, matchesLease: async () => false });
  assert.equal(sent.filter(s => s.p === rec.pane).length, 0,
    'no keystrokes into the foreign (recycled) pane');
  assert.equal(result, 'reopen', 'session revives in a fresh pane instead');
  assert.ok(sent.every(s => s.p === '%99'), 'any message goes to the new pane only');
});

test('dispatchOne still injects when the stamp matches the record lease', async () => {
  const rec = seed({ agent: 'claude', leaseId: 'L-mine' });
  const sent = [];
  const mux = {
    paneAlive: async () => true,
    capturePane: async () => '❯ ',
    paneCurrentCommand: async () => 'node',
    paneOwnerStamp: async () => 'L-mine',
    sendText: async (p, t) => sent.push({ p, t }),
  };
  const result = await dispatchOne(rec, { mux, matchesLease: async () => false });
  assert.equal(result, 'injected');
  assert.equal(sent.length, 1);
});

// --- monitor self-termination ------------------------------------------------------

test('monitor exits once its lease disappears (agent gone, pane became the user shell)', async () => {
  const address = { mux: 'tmux', paneOwner: null, pane: '%42' };
  const lease = { ...address, leaseId: 'L-mon', agent: 'claude', pid: process.pid, pidBirth: 'b' };
  writeLease(lease);
  const mux = {
    paneAlive: async () => true,
    capturePane: async () => 'just a shell prompt $',
    capturePaneVisible: async () => 'just a shell prompt $',
  };
  const monitor = createMonitor({
    muxName: 'tmux', paneOwner: null, pane: '%42', leaseId: 'L-mon',
    cwd: '/tmp/proj', mux, notifier: () => {},
  });
  await monitor._tick();
  assert.equal(monitor._running !== false, true, 'lease present — monitor keeps going');
  removeLease(address, 'L-mon');
  await monitor._tick();
  assert.equal(monitor._running, false, 'lease gone — monitor must exit');
});

test('a surviving stamp on a dead-agent pane never fakes busy/inject — session reopens', async () => {
  // The stamp outlives the agent (it dies with the PANE): after the user
  // quits claude in their own tmux, the pane is their shell, still stamped.
  // Identity says "our pane"; liveness must still gate busy/inject — else the
  // record is silently marked resumed (or worse, the resume message is typed
  // into the user's shell when their prompt contains ❯).
  const rec = seed({ agent: 'claude', leaseId: 'L-dead' });
  const sent = [];
  const mux = {
    paneAlive: async () => true,
    capturePane: async () => 'user@mac ~ ❯ ',     // shell prompt — idleRegex matches!
    paneCurrentCommand: async () => 'zsh',         // agent gone
    paneOwnerStamp: async () => 'L-dead',          // stamp survived the agent
    sendText: async (p, t) => sent.push({ p, t }),
    newWindow: async () => ({ pane: '%78', paneOwner: null }),
    sessionExists: async () => false,
    stampPaneOwner: async () => {},
  };
  const result = await dispatchOne(rec, { mux, matchesLease: async () => false });
  assert.equal(result, 'reopen', 'dead agent in our pane → revive, never busy/injected');
  assert.equal(sent.filter(s => s.p === rec.pane).length, 0,
    'the resume message must never land in the user shell');
});
