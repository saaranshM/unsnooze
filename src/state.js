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
  STATE_DIR, STATE_FILE, LOCK_DIR, STALE_LOCK_MS, PRUNE_AFTER_MS, ensureStateDir,
  writePrivateFile,
  DEDUPE_WINDOW_MS, STALE_AFTER_MS, PROBE_INTERVAL_MS, PROBE_MAX_MS,
  RESET_MARGIN_MS,
} from './config.js';
import { workspaceFingerprint } from './workspace.js';
import { makeLogger } from './logger.js';
import { addressHash } from './lease.js';
import { sourceRank } from './time-parser.js';

const log = makeLogger('state');

const EMPTY = () => ({
  version: 1, resumerPid: null, sessions: {}, calibration: {}, promptQueue: [], paneClosures: [],
});

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

// lockHolderAlive() can only ask "is this pid alive", never "is it still
// unsnooze". A leaked lock whose pid is later recycled onto some unrelated
// long-lived process therefore looks live forever, and every writer — daemon,
// CLI, in-agent hook — wedges permanently with no way out but deleting the
// directory by hand. Past this ceiling, age wins regardless.
//
// This is a deliberate trade, not a free win: stealing from a holder that IS
// still working puts two writers in the critical section, and the robbed one's
// rename then clobbers the thief's write — a lost update. It is chosen because
// a permanent unrecoverable wedge is the worse failure. The exposure is kept
// small by holding this lock only for in-memory work plus one write:
// upsertSession's git call is hoisted out for exactly this reason. Five
// minutes is ~200x the worst measured critical section.
//
// Known limit: both sides of the age are wall-clock, so a forward clock step
// (VM resume, laptop wake, a large NTP correction) can age a fresh lock past
// the ceiling at once. There is no cross-process monotonic clock to use
// instead, which is part of why the ceiling is generous rather than tight.
const HARD_STALE_LOCK_MS = Math.max(STALE_LOCK_MS * 30, 300_000);

function acquireLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let parentRepaired = false;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR, { mode: 0o700 });
      // Record the holder so a slow-but-alive writer is never robbed — age
      // alone can't tell a hung process from a busy one.
      try { writeFileSync(join(LOCK_DIR, 'pid'), String(process.pid), { mode: 0o600 }); } catch { /* best-effort */ }
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        // NOT contention. A missing STATE_DIR is worth exactly one immediate
        // repair-and-retry; every other errno (EACCES on an unwritable
        // ~/.unsnooze, EROFS, ENOSPC) must fall through to the same backoff
        // and deadline as any other failure. This branch used to `continue`
        // unconditionally, skipping both — and since mkdir -p on an existing
        // STATE_DIR succeeds as a no-op, an unwritable state dir spun here
        // forever at ~70% of a core, ignoring LOCK_TIMEOUT_MS, in every writer:
        // the daemon, the CLI, and the StopFailure hook inside the agent.
        if (!parentRepaired) {
          parentRepaired = true;
          try { ensureStateDir(); } catch { /* fall through to the backoff */ }
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`unsnooze: cannot create state lock at ${LOCK_DIR}: ${err.code || err.message}`);
        }
        sleepSync(50);
        // A *recurring* ENOENT means the directory keeps going away under us
        // (an uninstall racing a write), not that the one-shot repair failed.
        // Keep repairing it, but from the backoff — never in a tight loop.
        if (err.code === 'ENOENT') { try { ensureStateDir(); } catch { /* next pass */ } }
        continue;
      }
      try {
        const before = statSync(LOCK_DIR);
        const age = Date.now() - before.mtimeMs;
        if (age > STALE_LOCK_MS && (age > HARD_STALE_LOCK_MS || lockHolderAlive() !== true)) {
          // Re-stat immediately before removing. The staleness verdict above
          // costs a readFileSync + kill(), and in that gap another contender
          // can have stolen this same lock and created a fresh one — removing
          // that would drop a live holder's lock and break mutual exclusion.
          // A matching inode means it is still the dir we judged stale. This
          // narrows the window rather than closing it: a filesystem that
          // recycles a just-freed directory inode can hand the same number
          // back, and Windows may report 0 for both — in either case this
          // degrades to the old unconditional behaviour, never to a worse one.
          if (statSync(LOCK_DIR).ino === before.ino) {
            rmSync(LOCK_DIR, { recursive: true, force: true });   // steal from a dead/unknown holder
            log(`stole stale lock (age ${Math.round(age)}ms)`);
          }
          continue;
        }
      } catch { /* lock vanished between check and stat — retry */ }
      if (Date.now() > deadline) throw new Error(`unsnooze: state lock timeout after ${LOCK_TIMEOUT_MS}ms`);
      sleepSync(50);
    }
  }
}

function releaseLock() {
  try {
    // Only drop a lock we still hold. A stale-lock steal can rob a live
    // holder (see acquireLock); if that happened, the dir now belongs to the
    // thief, and removing it would hand a third writer a lock the thief still
    // believes is theirs. An unreadable/absent pid file means the lock is
    // ours-but-unstamped or already gone — both fall through to the remove.
    if (readFileSync(join(LOCK_DIR, 'pid'), 'utf-8') !== String(process.pid)) return;
  } catch { /* no pid file: our own best-effort stamp failed, or it's gone */ }
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
      // err.message, NOT logged: V8 embeds the first bytes of the input in
      // its JSON.parse message ("Unexpected token 'S', \"SUPER SECR\"..."),
      // so a state.json that is really a symlink to something else would
      // print that file's opening bytes into unsnooze.log. The quarantined
      // file is right there on disk for anyone who needs to see the content.
      log(`CORRUPT state.json quarantined to ${quarantine} (${err.name || 'parse error'})`);
    } catch { /* someone else quarantined it first */ }
    return EMPTY();
  }
}

function normalizeState(state) {
  if (!state || typeof state !== 'object') return EMPTY();
  state.sessions ||= {};
  // Calibration ring buffers (usage forecast) — never pruned with sessions.
  if (!state.calibration || typeof state.calibration !== 'object' || Array.isArray(state.calibration)) {
    state.calibration = {};
  }
  // One-shot prompt queue — always an array; corrupt/missing values reset empty.
  if (!Array.isArray(state.promptQueue)) state.promptQueue = [];
  // Short-lived pane-generation tombstones prevent a detection racing a
  // user-requested reap from publishing a just-closed pane as live.
  if (!Array.isArray(state.paneClosures)) state.paneClosures = [];
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
  ensureStateDir();
  acquireLock();
  try {
    const state = readState();
    const result = mutator(state) ?? state;
    // Owner-only: session records embed cwd paths and queued prompt text.
    writePrivateFile(STATE_FILE, join(STATE_DIR, `.state.tmp.${process.pid}`),
      JSON.stringify(result, null, 2));
    return result;
  } finally {
    releaseLock();
  }
}

// Insert or update a session record. Dedupes hook-vs-scrape double detection:
// if a record for the same pane was created within DEDUPE_WINDOW_MS, merge into
// it (a record WITH a sessionId wins over one without).
//
// `after(state, appliedRecord)` runs inside the same lock — used by usage
// calibration snapshots so stop + ceiling sample never race (1.13).
export function upsertSession(record, { after = null } = {}) {
  record = normalizeRecord({ ...record });
  // Computed BEFORE the lock, never inside the mutator. workspaceFingerprint
  // shells out to git, and execFileSync's `timeout` is a soft bound — it
  // sends SIGTERM at the deadline and then waits for the child to actually
  // exit, which a git wedged in uninterruptible I/O on a hung network mount
  // never does. That made it the one unbounded operation under the state
  // lock, and the only way a critical section could outlive
  // HARD_STALE_LOCK_MS and be stolen from a writer that is still working.
  // The cost of hoisting is one extra git call when the record turns out to
  // be a duplicate; the benefit is that the lock is only ever held for
  // in-memory work plus one write.
  // 'resuming' is included deliberately: the `closing` branch inside the
  // mutator can flip such a record to 'stopped', and the apply site below
  // would then want a baseline this precompute never made. No caller passes
  // 'resuming' today — this keeps the hoist from becoming a trap for one that
  // later does.
  const needsFingerprint = ['stopped', 'resuming'].includes(record.status)
    && record.workspace === undefined;
  const fingerprint = needsFingerprint ? workspaceFingerprint(record.cwd) : undefined;
  return updateState(state => {
    prune(state);
    const closing = state.paneClosures.find(c => c.pane && c.leaseId
      && c.mux === record.mux && c.paneOwner === record.paneOwner
      && c.pane === record.pane && c.leaseId === record.leaseId);
    if (closing) {
      // The close command has already been submitted. Keep the stop, but make
      // it reopenable instead of attaching it to a pane that is going away.
      record = {
        ...record,
        pane: null,
        paneOwner: null,
        muxSession: null,
        leaseId: null,
        pid: null,
        pidBirth: null,
        status: record.status === 'resuming' ? 'stopped' : record.status,
        resumeEpisodeAt: null,
      };
    }
    let applied = null;
    const existingKey = findDuplicate(state, record);
    if (existingKey) {
      const existing = state.sessions[existingKey];
      const staleBanner = existing.status === 'resumed' && !existing.bannerCleared
        && record.status === 'stopped';
      // Mirror monitor.js §7 on the merge path: a same-or-worse source may only
      // pull the wake earlier, never push it later. Without this, a banner left
      // on screen after its reset passed re-records "now + margin" on every
      // scrape tick, so the resumer never sees the session become due.
      // ...but only while the existing record is still a live stop. monitor.js
      // scopes the same rule structurally — §7 upgrades only the record that
      // monitor is currently tracking — and the merge path has no such context,
      // so it uses the staleness horizon the rest of the codebase already
      // recognises. A record older than that has been abandoned; a stop
      // arriving now is a new one, and its schedule must win rather than be
      // held back by a week-old banner.
      const existingAge = Date.now() - (existing.bannerAt ?? existing.detectedAt ?? 0);
      const stillLive = existingAge < STALE_AFTER_MS;
      const keepReset = existing.status === 'stopped' && record.status === 'stopped'
        && stillLive
        && typeof existing.resetAt === 'number' && typeof record.resetAt === 'number'
        && sourceRank(record.resetSource) <= sourceRank(existing.resetSource)
        && record.resetAt > existing.resetAt;
      const merged = {
        ...existing,
        ...record,
        ...(keepReset ? {
          resetAt: existing.resetAt,
          resetSource: existing.resetSource,
          bannerAt: existing.bannerAt,
        } : {}),
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
      if (merged.status !== 'resuming') merged.resumeEpisodeAt = null;
      state.sessions[existingKey] = merged;
      applied = merged;
      log(`merged duplicate detection for pane ${record.pane} into ${existingKey}`);
    } else {
      // Baseline for the stale-workspace guard, captured once at stop time.
      // (Merged duplicates above keep the ORIGINAL baseline — spread
      // semantics — so this is applied on the non-duplicate branch ONLY.
      // Assigning it before the branch would let the merge spread it over the
      // existing record's baseline and silently reset it.)
      if (record.status === 'stopped' && record.workspace === undefined) {
        record.workspace = fingerprint;
      }
      const key = record.sessionId || `pane:${addressHash(record)}:${record.detectedAt}`;
      applied = { ...record, key };
      state.sessions[key] = applied;
    }
    if (typeof after === 'function' && applied) {
      try { after(state, applied); } catch (err) {
        log(`upsertSession after-hook failed: ${err.message}`);
      }
    }
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

// `expect` / `expectCutoff`: compare-and-set — apply only while the record is
// still in the expected state and stop episode. Snapshot-based decisions must
// not clobber a record that moved on or was refreshed by a newer limit.
export function setStatus(key, status, extra = {}, {
  expect = null, expectCutoff = null,
} = {}) {
  return updateState(state => {
    const s = state.sessions[key];
    if (!s) return state;
    if (expect && !expect.includes(s.status)) return state;
    if (expectCutoff != null && (s.bannerAt ?? s.detectedAt) !== expectCutoff) return state;
    Object.assign(s, extra, { status });
    if (status !== 'resuming') s.resumeEpisodeAt = null;
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
  if (Array.isArray(state.promptQueue)) {
    state.promptQueue = state.promptQueue.filter(e => {
      const terminal = ['delivered', 'failed', 'cancelled'].includes(e.status);
      const ts = e.deliveredAt ?? e.createdAt ?? 0;
      return !(terminal && ts < cutoff);
    });
  }
  const closureCutoff = Date.now() - DEDUPE_WINDOW_MS;
  state.paneClosures = (Array.isArray(state.paneClosures) ? state.paneClosures : [])
    .filter(c => Number.isFinite(c?.claimedAt) && c.claimedAt >= closureCutoff);
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
    // 'failed' is deliberately NOT swept: its lastError is the post-mortem
    // ("why didn't my session wake?") and a give-up was once erased within
    // 30 seconds of happening. Age-based prune() owns failed-record expiry.
    if (!['resumed', 'cancelled'].includes(rec.status)) continue;
    if (!rec.pane) {
      drop.push({ key: rec.key, status: rec.status, cutoff: rec.bannerAt ?? rec.detectedAt });
      continue;
    }
    try {
      const mux = resolveMux(rec);
      if (!(await mux.paneAlive(rec.pane))) {
        drop.push({ key: rec.key, status: rec.status, cutoff: rec.bannerAt ?? rec.detectedAt });
      }
    } catch {
      drop.push({ key: rec.key, status: rec.status, cutoff: rec.bannerAt ?? rec.detectedAt });
    }
  }
  if (drop.length === 0) return 0;
  let removed = 0;
  updateState(s => {
    for (const snapshot of drop) {
      const current = s.sessions[snapshot.key];
      if (current?.status !== snapshot.status
        || (current.bannerAt ?? current.detectedAt) !== snapshot.cutoff) continue;
      delete s.sessions[snapshot.key];
      removed += 1;
    }
    return s;
  });
  return removed;
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
    // the record is still where the snapshot saw it, including its episode.
    const episode = rec.bannerAt ?? rec.detectedAt;
    const next = setStatus(rec.key, 'failed', {
      lastError: rec.pane ? 'stale: pane dead' : 'stale: pane absent',
      verifyRetries: 0,
    }, { expect: ['stopped', 'resuming'], expectCutoff: episode });
    const applied = next.sessions[rec.key];
    if (applied?.status !== 'failed'
      || (applied.bannerAt ?? applied.detectedAt) !== episode) continue;
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
