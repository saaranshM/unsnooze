// Part-3 correctness fixes from the 2026-07 audit:
//   time-parser: weekly-reset DST re-derivation, garbage-clock clamp,
//                anchored "wait <duration>" (no spurious prose matches)
//   state:       setStatus CAS (markStaleAbandoned must not clobber a
//                just-resumed record), lock steal verifies the holder pid
//   reap:        user-invoked reap skips recently-active `resumed` panes
//   install:     first-ever backup preserved as .unsnooze-orig

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-part3-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_LOCK_TIMEOUT_MS = '400';   // keep lock-wait tests fast

const { parseResetTime, resetAtMs } = await import('../src/time-parser.js');
const { upsertSession, readState, setStatus, updateState, markStaleAbandoned } = await import('../src/state.js');
const { reap } = await import('../src/reap.js');
const { cmdInstall } = await import('../src/install.js');
const { LOCK_DIR } = await import('../src/config.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

let seedCounter = 100;
function seed(overrides = {}) {
  seedCounter += 1;
  const rec = {
    sessionId: `00000000-0000-4000-8000-${String(seedCounter).padStart(12, '0')}`,
    cwd: '/tmp/proj', pane: `%${seedCounter}`, mux: 'tmux', paneOwner: null,
    status: 'stopped', limitType: '5h', detectedVia: 'hook',
    detectedAt: Date.now() - 3_600_000, resetAt: Date.now() - 1000,
    resetSource: 'absolute', attempts: 0,
    ...overrides,
  };
  const state = upsertSession(rec);
  return Object.values(state.sessions).find(s => s.sessionId === rec.sessionId);
}

// --- time-parser -----------------------------------------------------------------

test('a garbage clock (45:99) never throws — falls back instead', () => {
  const parsed = parseResetTime('You hit your limit · resets 45:99');
  // Either the clock is rejected at parse time (null) or resetAtMs degrades
  // to fallback — what must NEVER happen is the RangeError from formatting
  // an Invalid Date.
  let out;
  assert.doesNotThrow(() => {
    out = resetAtMs(parsed, { marginMs: 0, fallbackMs: 60_000, now: new Date('2026-07-16T00:00:00Z') });
  });
  assert.equal(out.source, 'fallback');
});

test('weekly reset lands on the exact wall-clock time across a DST boundary', () => {
  // Banner on Thu 2026-03-05 (EST); target Tue 2026-03-10 9am — DST starts
  // Sun 2026-03-08. Naive +24h day-stepping yields 10am EDT (1h late).
  const parsed = parseResetTime('Weekly limit reached · resets Tuesday 9am (America/New_York)');
  const { at, source } = resetAtMs(parsed, {
    marginMs: 0, fallbackMs: 60_000,
    now: new Date('2026-03-05T15:00:00Z'),   // Thu 10:00 EST
  });
  assert.equal(source, 'absolute');
  assert.equal(new Date(at).toISOString(), '2026-03-10T13:00:00.000Z',
    'Tue 9:00 EDT — not 10:00 (the un-re-derived value)');
});

test('"wait …" only parses when a duration immediately follows', () => {
  // Real banner: still parses.
  assert.equal(parseResetTime('Please wait 5 minutes.').waitMs, 5 * 60_000);
  assert.equal(parseResetTime('please wait for 30 seconds').waitMs, 30_000);
  // Prose where "wait" is followed by words and a duration appears later —
  // previously summed "2 days" into a bogus reset time.
  const spurious = parseResetTime('Please wait — reviews usually take 2 days for the team');
  assert.equal(spurious?.waitMs, undefined, 'no duration right after "wait" → no relative parse');
});

// --- state: setStatus CAS + markStaleAbandoned race ---------------------------------

test('setStatus with expect only fires when the current status matches', () => {
  const rec = seed({ status: 'stopped' });
  setStatus(rec.key, 'resumed');
  // A stale sweeper decided "failed" from an old snapshot — must not clobber.
  setStatus(rec.key, 'failed', { lastError: 'stale: pane dead' }, { expect: ['stopped', 'resuming'] });
  assert.equal(readState().sessions[rec.key].status, 'resumed');
  // When the expectation holds, it applies normally.
  setStatus(rec.key, 'stopped');
  setStatus(rec.key, 'failed', {}, { expect: ['stopped', 'resuming'] });
  assert.equal(readState().sessions[rec.key].status, 'failed');
});

test('markStaleAbandoned cannot clobber a record that resumed mid-sweep', async () => {
  const rec = seed({ status: 'stopped', detectedAt: Date.now() - 30 * 86_400_000 });
  const mux = {
    // The sweep's liveness probe races a real resume: by the time it answers,
    // the record has already moved on.
    paneAlive: async () => {
      setStatus(rec.key, 'resumed', { lastAttemptAt: Date.now() });
      return false;
    },
  };
  await markStaleAbandoned({ resolveMux: () => mux, staleAfterMs: 86_400_000 });
  assert.equal(readState().sessions[rec.key].status, 'resumed', 'resumed survives the sweep');
});

// --- state: lock steal verifies the holder ------------------------------------------

test('a stale lock from a dead pid is stolen; a live holder is honored', () => {
  // Dead holder, old mtime → steal and proceed.
  rmSync(LOCK_DIR, { recursive: true, force: true });
  mkdirSync(LOCK_DIR, { recursive: true });
  writeFileSync(join(LOCK_DIR, 'pid'), '999999999');
  const past = new Date(Date.now() - 60_000);
  utimesSync(LOCK_DIR, past, past);
  assert.doesNotThrow(() => updateState(s => s), 'dead-pid lock must be stolen');

  // Live holder (this very process), old mtime → honored until timeout.
  rmSync(LOCK_DIR, { recursive: true, force: true });
  mkdirSync(LOCK_DIR, { recursive: true });
  writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid));
  utimesSync(LOCK_DIR, past, past);
  assert.throws(() => updateState(s => s), /state lock timeout/,
    'a live-but-slow writer must never have its lock stolen');
  rmSync(LOCK_DIR, { recursive: true, force: true });
});

// --- reap: resumed records need an idle threshold -------------------------------------

test('reap --yes skips a recently-active resumed pane, closes an idle one', async () => {
  process.env.UNSNOOZE_REAP_IDLE_AFTER = String(86_400_000);   // 1 day
  try {
    const active = seed({ status: 'resumed', leaseId: 'L-a', lastAttemptAt: Date.now() - 60_000 });
    const idle = seed({ status: 'resumed', leaseId: 'L-b', lastAttemptAt: Date.now() - 2 * 86_400_000 });
    const closed = [];
    const mux = {
      paneAlive: async () => true,
      paneOwnerStamp: async p => (p === active.pane ? 'L-a' : 'L-b'),
      closePane: async p => closed.push(p),
      available: () => false, listSessions: async () => [],
    };
    const { actions } = await reap({ yes: true, resolveMux: () => mux });
    assert.ok(!closed.includes(active.pane), 'recently-active resumed pane stays open');
    assert.ok(closed.includes(idle.pane), 'idle resumed pane is closed');
    const skip = actions.find(a => a.key === active.key);
    assert.equal(skip.kind, 'skip-active');
  } finally {
    delete process.env.UNSNOOZE_REAP_IDLE_AFTER;
  }
});

// --- install: first backup preserved as .orig -------------------------------------------

test('re-running install never clobbers the pristine pre-unsnooze backup', () => {
  const settings = join(DIR, 'claude-settings.json');
  const zshrc = join(DIR, 'zshrc');
  writeFileSync(settings, JSON.stringify({ theme: 'original' }) + '\n');
  writeFileSync(zshrc, '# my pristine zshrc\n');

  cmdInstall(['--yes', '--settings', settings, '--zshrc', zshrc]);
  assert.match(readFileSync(`${settings}.unsnooze-orig`, 'utf-8'), /original/,
    'first run snapshots the pre-unsnooze settings');
  assert.match(readFileSync(`${zshrc}.unsnooze-orig`, 'utf-8'), /pristine/,
    'first run snapshots the pre-unsnooze rc');

  // Second run: .orig untouched, .bak rolls.
  cmdInstall(['--yes', '--settings', settings, '--zshrc', zshrc]);
  assert.match(readFileSync(`${settings}.unsnooze-orig`, 'utf-8'), /original/);
  assert.doesNotMatch(readFileSync(`${settings}.unsnooze-orig`, 'utf-8'), /unsnooze\.js/,
    '.orig must never contain the installed hook');
  assert.match(readFileSync(`${settings}.unsnooze-bak`, 'utf-8'), /unsnooze\.js/,
    '.bak rolls forward to the pre-second-run content');
  assert.ok(existsSync(`${zshrc}.unsnooze-orig`));
});
