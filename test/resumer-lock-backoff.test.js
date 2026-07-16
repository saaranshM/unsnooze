// F6 — resumer retry backoff + singleton-lock hygiene.
// Incident evidence: 5 resume attempts burned in ~2.5 minutes ("giving up
// after 5 attempts" within the same tick window), and hours of
// "another resumer holds the lock — daemon waiting" spam at every 30s tick.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-lock-backoff-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';

const {
  retryBackoffMs, shouldLogLockWait, acquireSingleton, releaseSingleton, routeDispatchOutcome,
  looksLikeResumerCommand,
} = await import('../src/resumer.js');
const { upsertSession, readState } = await import('../src/state.js');
const { RESUMER_LOCK } = await import('../src/config.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

function seed(overrides = {}) {
  const rec = {
    sessionId: `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
    cwd: '/tmp/proj', pane: overrides.pane || '%9', mux: 'tmux', paneOwner: null,
    status: 'stopped', limitType: '5h', detectedVia: 'hook',
    detectedAt: Date.now() - 3_600_000, resetAt: Date.now() - 1000,
    resetSource: 'absolute', attempts: 0,
    ...overrides,
  };
  const state = upsertSession(rec);
  return Object.values(state.sessions).find(s => s.sessionId === rec.sessionId);
}

// --- retry backoff -----------------------------------------------------------

test('retryBackoffMs doubles per attempt and caps at 30 minutes', () => {
  assert.equal(retryBackoffMs(1), 60_000);
  assert.equal(retryBackoffMs(2), 120_000);
  assert.equal(retryBackoffMs(3), 240_000);
  assert.equal(retryBackoffMs(4), 480_000);
  assert.equal(retryBackoffMs(10), 1_800_000);   // capped
  assert.equal(retryBackoffMs(0), 60_000);        // degenerate input → base
});

test('retry outcome pushes resetAt into the future by the backoff (no instant re-dispatch)', () => {
  const now = Date.now();
  const rec = seed({ pane: '%61', attempts: 0 });
  routeDispatchOutcome('retry', rec, new Map(), { now });
  const after1 = readState().sessions[rec.key];
  assert.equal(after1.attempts, 1);
  assert.equal(after1.resetAt, now + 60_000, 'attempt 1 → due again in 1 min, not immediately');

  routeDispatchOutcome('retry', after1, new Map(), { now });
  const after2 = readState().sessions[rec.key];
  assert.equal(after2.attempts, 2);
  assert.equal(after2.resetAt, now + 120_000, 'attempt 2 → 2 min backoff');
});

// --- lock-wait log throttling -------------------------------------------------

test('shouldLogLockWait logs the first wait, then every 30th tick (~15 min at 30s polls)', () => {
  const logged = [];
  for (let n = 1; n <= 65; n++) if (shouldLogLockWait(n)) logged.push(n);
  assert.deepEqual(logged, [1, 30, 60]);
});

// --- singleton lock hygiene ----------------------------------------------------

test('acquireSingleton takes a free lock atomically and records our pid', () => {
  rmSync(RESUMER_LOCK, { force: true });
  assert.equal(acquireSingleton(), true);
  assert.equal(readFileSync(RESUMER_LOCK, 'utf-8'), String(process.pid));
  assert.equal(acquireSingleton(), true, 're-acquiring our own lock is idempotent');
  releaseSingleton();
  assert.ok(!existsSync(RESUMER_LOCK));
});

test('acquireSingleton defers to a live holder that really is a resumer', () => {
  writeFileSync(RESUMER_LOCK, String(process.ppid));   // live foreign pid
  assert.equal(acquireSingleton({ isResumer: () => true }), false);
  rmSync(RESUMER_LOCK, { force: true });
});

test('acquireSingleton steals the lock from a recycled pid that is not a resumer', () => {
  // Pid reuse: the lock names a live process, but it is some unrelated
  // program — waiting behind it forever means stops never dispatch.
  writeFileSync(RESUMER_LOCK, String(process.ppid));
  assert.equal(acquireSingleton({ isResumer: () => false }), true);
  assert.equal(readFileSync(RESUMER_LOCK, 'utf-8'), String(process.pid));
  releaseSingleton();
});

test('acquireSingleton replaces a dead-pid or garbage lock', () => {
  const dead = spawnSync('true').pid;   // exited — pid is dead (short of instant reuse)
  writeFileSync(RESUMER_LOCK, String(dead));
  assert.equal(acquireSingleton(), true);
  releaseSingleton();

  writeFileSync(RESUMER_LOCK, 'not-a-pid');
  assert.equal(acquireSingleton(), true);
  releaseSingleton();
});

test('manual resume-now records are exempt from retry backoff', () => {
  // `unsnooze resume-now` promises an immediate wake; a transient capture
  // error must not silently defer it minutes into the future.
  const now = Date.now();
  const rec = seed({ pane: '%62', attempts: 3, manual: true });
  routeDispatchOutcome('retry', rec, new Map(), { now });
  const after1 = readState().sessions[rec.key];
  assert.equal(after1.attempts, 4);
  assert.equal(after1.resetAt, now, 'manual records stay due immediately');
});

test('looksLikeResumerCommand honors only real resumer/daemon command lines', () => {
  // Lock holders are only ever `_resumer` or `daemon` processes — anything
  // else on a recycled pid must not be allowed to squat the lock forever.
  assert.equal(looksLikeResumerCommand('node /x/unsnooze/bin/unsnooze.js _resumer'), true);
  assert.equal(looksLikeResumerCommand('node /x/lib/node_modules/unsnooze/bin/unsnooze.js daemon'), true);
  assert.equal(looksLikeResumerCommand('node /x/unsnooze/bin/unsnooze.js _run claude'), false);
  assert.equal(looksLikeResumerCommand('/usr/bin/vim unsnooze-notes.md'), false);
  assert.equal(looksLikeResumerCommand('WindowServer -daemon'), false);
  assert.equal(looksLikeResumerCommand(''), true, 'no evidence → honor the lock (never steal on doubt)');
});
