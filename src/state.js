// Shared multi-writer state store: ~/.unsnooze/state.json.
// Writers: N monitors, the StopFailure hook, the resumer, CLI subcommands.
// Safety: mkdir-based lock (atomic on POSIX) around read-modify-write, tmp
// file + rename for atomic replacement, stale-lock stealing, corrupt-file
// quarantine. All synchronous — callers are short-lived or infrequent.

import {
  mkdirSync, rmSync, readFileSync, writeFileSync, renameSync,
  existsSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  STATE_DIR, STATE_FILE, LOCK_DIR, STALE_LOCK_MS, PRUNE_AFTER_MS,
  DEDUPE_WINDOW_MS, STALE_AFTER_MS, PROBE_INTERVAL_MS, PROBE_MAX_MS,
  RESET_MARGIN_MS,
} from './config.js';
import { workspaceFingerprint } from './workspace.js';
import { makeLogger } from './logger.js';
import { addressHash } from './lease.js';

const log = makeLogger('state');

const EMPTY = () => ({ version: 1, resumerPid: null, sessions: {} });

function sleepSync(ms) {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

const LOCK_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.UNSNOOZE_LOCK_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(v) ? v : 5_000;
})();

// Is the pid recorded inside the lock dir still alive? Old-version locks have
// no pid file — unknown (null) so age-based stealing still applies to them.
function lockHolderAlive() {
  try {
    const pid = parseInt(readFileSync(join(LOCK_DIR, 'pid'), 'utf-8'), 10);
    if (!Number.isFinite(pid)) return null;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'ESRCH' ? false : null;   // dead vs unreadable/no-permission
  }
}

function acquireLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      // Record the holder so a slow-but-alive writer is never robbed — age
      // alone can't tell a hung process from a busy one.
      try { writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid)); } catch { /* best-effort */ }
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') { mkdirSync(STATE_DIR, { recursive: true }); continue; }
      try {
        const age = Date.now() - statSync(LOCK_DIR).mtimeMs;
        if (age > STALE_LOCK_MS && lockHolderAlive() !== true) {
          rmSync(LOCK_DIR, { recursive: true, force: true });   // steal from a dead/unknown holder
          log(`stole stale lock (age ${Math.round(age)}ms)`);
          continue;
        }
      } catch { /* lock vanished between check and stat — retry */ }
      if (Date.now() > deadline) throw new Error(`unsnooze: state lock timeout after ${LOCK_TIMEOUT_MS}ms`);
      sleepSync(50);
    }
  }
}

function releaseLock() {
  try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* already gone */ }
}

export function readState() {
  try {
    return normalizeState(JSON.parse(readFileSync(STATE_FILE, 'utf-8')));
  } catch (err) {
    if (err.code === 'ENOENT') return EMPTY();
    // Corrupt file: quarantine loudly, start fresh — never crash the hook path.
    try {
      const quarantine = `${STATE_FILE}.corrupt.${Date.now()}`;
      renameSync(STATE_FILE, quarantine);
      log(`CORRUPT state.json quarantined to ${quarantine}: ${err.message}`);
    } catch { /* someone else quarantined it first */ }
    return EMPTY();
  }
}

function normalizeState(state) {
  if (!state || typeof state !== 'object') return EMPTY();
  state.sessions ||= {};
  for (const rec of Object.values(state.sessions)) normalizeRecord(rec);
  return state;
}

// In-place upgrades for records written by older unsnooze versions. Must stay
// additive and safe: never drop a live session, never invent a far-future wait.
function normalizeRecord(rec) {
  if (!rec.mux) rec.mux = 'tmux';
  // Pre-multiplexer field: tmuxSession → muxSession (idempotent).
  if (!rec.muxSession && rec.tmuxSession) rec.muxSession = rec.tmuxSession;
  // tmux pane ids are server-global. Pre-1.10 newWindow() wrongly stored the
  // session name as paneOwner, which broke leaseMatches against live leases
  // (always written with paneOwner: null). Clear it so injection works again.
  if (rec.mux === 'tmux' && rec.paneOwner != null) rec.paneOwner = null;
  else if (rec.mux === 'tmux' && rec.paneOwner === undefined) rec.paneOwner = null;
  // Pre-probe era: fallback records were scheduled at now+5h. After upgrade,
  // only pull in waits that are *beyond* the probe ladder (old blind 5h
  // guesses). Do not touch fresh probe schedules (≤ PROBE_MAX + margin) or
  // absolute/relative sources — those times are intentional.
  if (rec.resetSource === 'fallback' && typeof rec.resetAt === 'number') {
    const beyondProbeLadder = Date.now() + PROBE_MAX_MS + RESET_MARGIN_MS;
    if (rec.resetAt > beyondProbeLadder) {
      rec.resetAt = Date.now() + PROBE_INTERVAL_MS;
    }
  }
  // bannerAt / probeCount / resetSource provenance fields are optional; callers
  // tolerate absence. Do not invent them here.
  return rec;
}

// Locked read-modify-write. mutator receives the state object and mutates it
// (or returns a replacement). Returns the final state.
export function updateState(mutator) {
  mkdirSync(STATE_DIR, { recursive: true });
  acquireLock();
  try {
    const state = readState();
    const result = mutator(state) ?? state;
    const tmp = join(STATE_DIR, `.state.tmp.${process.pid}`);
    writeFileSync(tmp, JSON.stringify(result, null, 2));
    renameSync(tmp, STATE_FILE);
    return result;
  } finally {
    releaseLock();
  }
}

// Insert or update a session record. Dedupes hook-vs-scrape double detection:
// if a record for the same pane was created within DEDUPE_WINDOW_MS, merge into
// it (a record WITH a sessionId wins over one without).
export function upsertSession(record) {
  record = normalizeRecord({ ...record });
  return updateState(state => {
    prune(state);
    const existingKey = findDuplicate(state, record);
    if (existingKey) {
      const existing = state.sessions[existingKey];
      const staleBanner = existing.status === 'resumed' && !existing.bannerCleared
        && record.status === 'stopped';
      const merged = {
        ...existing,
        ...record,
        // Never downgrade a known sessionId to null.
        sessionId: record.sessionId || existing.sessionId,
        // A detection that races an in-flight resume must not flip the record
        // back to 'stopped' — the post-resume verify pass owns that outcome.
        status: existing.status === 'resuming'
          || staleBanner
          ? existing.status : record.status,
        attempts: staleBanner ? existing.attempts : record.attempts,
        lastAttemptAt: staleBanner ? existing.lastAttemptAt : record.lastAttemptAt,
        key: existingKey,
      };
      state.sessions[existingKey] = merged;
      log(`merged duplicate detection for pane ${record.pane} into ${existingKey}`);
      return state;
    }
    // Baseline for the stale-workspace guard, captured once at stop time.
    // (Merged duplicates above keep the ORIGINAL baseline — spread semantics.)
    if (record.status === 'stopped' && record.workspace === undefined) {
      record.workspace = workspaceFingerprint(record.cwd);
    }
    const key = record.sessionId || `pane:${addressHash(record)}:${record.detectedAt}`;
    state.sessions[key] = { ...record, key };
    return state;
  });
}

function findDuplicate(state, record) {
  if (record.sessionId && state.sessions[record.sessionId]) return record.sessionId;
  for (const [key, s] of Object.entries(state.sessions)) {
    // Same sessionId living under a pane-based key (a scrape record that later
    // learned its id through a merge).
    if (record.sessionId && s.sessionId === record.sessionId) return key;
    // 'resuming' counts too: while the resumer types into a pane, a scrape can
    // still see the banner for a few hundred ms — that must not fork a second
    // record (it would double-resume the session).
    if (s.pane && record.pane && addressHash(s) === addressHash(record)
      && (s.status === 'stopped' || s.status === 'resuming'
        || (s.status === 'resumed' && !s.bannerCleared))
      && Math.abs((s.detectedAt || 0) - record.detectedAt) < DEDUPE_WINDOW_MS) {
      return key;
    }
    // A transcript/hook record with a sessionId matches a scrape record that
    // never learned its id — same agent, same cwd, same detection window.
    // Known trade-off: TWO different sessions of the same agent in the same
    // cwd stopping within the window would wrongly merge — but a pane session
    // writes the very transcript the watcher reads, so same-cwd evidence is
    // almost always the same session, and the alternative (two records) would
    // double-resume it.
    if (record.sessionId && !s.sessionId && (!record.pane || !s.pane)
      && s.agent === record.agent && s.cwd && s.cwd === record.cwd
      && s.status === 'stopped'
      && Math.abs((s.detectedAt || 0) - record.detectedAt) < DEDUPE_WINDOW_MS) {
      return key;
    }
  }
  return null;
}

// `expect`: compare-and-set — apply only while the record is still in one of
// the listed statuses. Sweepers that decide from a snapshot (markStaleAbandoned)
// must not clobber a record that moved on (e.g. to 'resumed') mid-decision.
export function setStatus(key, status, extra = {}, { expect = null } = {}) {
  return updateState(state => {
    const s = state.sessions[key];
    if (!s) return state;
    if (expect && !expect.includes(s.status)) return state;
    Object.assign(s, extra, { status });
    return state;
  });
}

// Drop terminal records older than PRUNE_AFTER_MS. Exported so the resumer
// can run it on a schedule (not only when a new limit-stop is upserted).
export function prune(state) {
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  for (const [key, s] of Object.entries(state.sessions)) {
    const terminal = ['resumed', 'failed', 'cancelled'].includes(s.status);
    const ts = s.lastAttemptAt || s.detectedAt || 0;
    if (terminal && ts < cutoff) delete state.sessions[key];
  }
}

export function pruneNow() {
  return updateState(state => { prune(state); return state; });
}

// Drop terminal records whose pane is dead or absent immediately (regardless
// of age). Live-pane terminal records keep the 7-day prune rule above.
// resolveMux(rec) → mux backend with paneAlive; paneAlive failures count as dead.
export async function sweepRecords({ resolveMux } = {}) {
  if (typeof resolveMux !== 'function') {
    throw new Error('unsnooze: sweepRecords requires resolveMux');
  }
  const state = readState();
  const drop = [];
  for (const rec of Object.values(state.sessions)) {
    if (!['resumed', 'failed', 'cancelled'].includes(rec.status)) continue;
    if (!rec.pane) {
      drop.push(rec.key);
      continue;
    }
    try {
      const mux = resolveMux(rec);
      if (!(await mux.paneAlive(rec.pane))) drop.push(rec.key);
    } catch {
      drop.push(rec.key);
    }
  }
  if (drop.length === 0) return 0;
  updateState(s => {
    for (const key of drop) delete s.sessions[key];
    return s;
  });
  return drop.length;
}

// Non-terminal records with a dead/absent pane and old detectedAt are marked
// failed so the daemon stops resurrecting long-abandoned sessions.
export async function markStaleAbandoned({
  resolveMux, staleAfterMs = STALE_AFTER_MS, now = Date.now(),
} = {}) {
  if (typeof resolveMux !== 'function') {
    throw new Error('unsnooze: markStaleAbandoned requires resolveMux');
  }
  const cutoff = now - staleAfterMs;
  let marked = 0;
  for (const rec of Object.values(readState().sessions)) {
    if (!['stopped', 'resuming'].includes(rec.status)) continue;
    if ((rec.detectedAt || 0) > cutoff) continue;
    let dead = !rec.pane;
    if (!dead) {
      try {
        dead = !(await resolveMux(rec).paneAlive(rec.pane));
      } catch {
        dead = true;
      }
    }
    if (!dead) continue;
    // CAS: the async liveness probe races real resumes — only mark failed if
    // the record is still where the snapshot saw it.
    setStatus(rec.key, 'failed', {
      lastError: rec.pane ? 'stale: pane dead' : 'stale: pane absent',
      verifyRetries: 0,
    }, { expect: ['stopped', 'resuming'] });
    marked += 1;
    log(`${rec.key}: marked failed (stale abandoned, detectedAt ${new Date(rec.detectedAt || 0).toISOString()})`);
  }
  return marked;
}

export function activeStopped(state = readState()) {
  return Object.values(state.sessions).filter(s => s.status === 'stopped');
}

export function dueSessions(now = Date.now(), state = readState()) {
  return activeStopped(state).filter(s => (s.resetAt || 0) <= now);
}
