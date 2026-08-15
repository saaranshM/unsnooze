// Resumer daemon (`unsnooze _resumer`) — SINGLETON. Watches state.json for stopped
// sessions, polls wall-clock against the earliest resetAt (interval polling,
// never one long setTimeout — survives laptop sleep; a wake past the target
// fires on the next tick), then re-opens/continues every due session.
// Exits when no non-terminal records remain; the next limit event respawns it.

import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { getMultiplexer } from './multiplexer.js';
import {
  RESUMER_LOCK, STATE_DIR, POLL_INTERVAL_MS, STAGGER_MS, VERIFY_DELAY_MS,
  BUSY_DEFER_MS, MAX_BUSY_DEFERS, MAX_RESUME_ATTEMPTS, READY_TIMEOUT_MS,
  CAPTURE_LINES, PANE_SCAN_LINES, RESUME_SESSION_NAME,
  RESET_MARGIN_MS, FALLBACK_RESET_MS, PROBE_INTERVAL_MS, PROBE_MAX_MS,
} from './config.js';
import { detectLimit, isBusy } from './patterns.js';
import { getAgent } from './agents/index.js';
import { parseResetTime, resetAtMs, nextProbeDelayMs } from './time-parser.js';
import {
  readState, updateState, setStatus, dueSessions, activeStopped,
  prune, sweepRecords, markStaleAbandoned,
} from './state.js';
import { approxTokens, hasClaudeParentUsageAfter } from './sessions.js';
import { latestRateLimitFromTranscript } from './watchers/claude.js';
import { getConfig, resolveResumeMessage, resolveResumeExtraArgs } from './settings.js';
import { workspaceFingerprint, workspaceChanged, describeChange } from './workspace.js';
import { notify } from './notify.js';
import { UNSNOOZE_BIN, spawnDetached, pidAlive } from './spawn.js';
import { restartOnVersionSkew, hasVersionSkew, PKG_VERSION } from './update-check.js';
import { makeLogger } from './logger.js';
import { createLeaseId, leaseMatches, paneOwnedByRecord } from './lease.js';
import { autoReapIfEnabled, attachHint } from './reap.js';
import { tickUsageWarnings } from './usage.js';

const log = makeLogger('resumer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_VERIFY_RETRIES = 3;
const ctxOf = rec => ({ mux: rec.mux, pane: rec.pane, paneOwner: rec.paneOwner });

// Is the lock-holder pid actually an unsnooze resumer? Pids get recycled: a
// lock naming a live-but-unrelated program would otherwise be honored forever
// and stops would never dispatch. Lock acquirers are only ever `_resumer` or
// `daemon` processes, so require both tokens — a bare /unsnooze/ substring
// would let any process that merely mentions the name squat the lock.
// No evidence (empty/failed ps) → true: never steal on doubt.
export function looksLikeResumerCommand(cmd) {
  const c = String(cmd || '').trim();
  if (c === '') return true;
  return /unsnooze/i.test(c) && /(?:^|\s)(?:_resumer|daemon)(?:\s|$)/.test(c);
}

function defaultIsResumer(pid) {
  try {
    const r = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' });
    if (r.error || r.status !== 0) return true;
    return looksLikeResumerCommand(r.stdout);
  } catch {
    return true;
  }
}

// Atomic acquire: `wx` create wins or loses the race outright — no
// read-check-write window. A held lock is honored only when its pid is alive
// AND looks like a resumer; stale/garbage/recycled locks are replaced.
export function acquireSingleton({ isResumer = defaultIsResumer } = {}) {
  mkdirSync(STATE_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(RESUMER_LOCK, String(process.pid), { flag: 'wx' });
      return true;
    } catch { /* lock exists — inspect the holder below */ }
    let pid = NaN;
    try { pid = parseInt(readFileSync(RESUMER_LOCK, 'utf-8'), 10); }
    catch { /* vanished between wx and read — retry the create */ }
    if (pid === process.pid) return true;   // we already hold it
    if (Number.isFinite(pid) && pidAlive(pid) && isResumer(pid)) return false;
    try { unlinkSync(RESUMER_LOCK); } catch { /* raced with another cleaner */ }
  }
  return false;   // lost the post-cleanup race to another acquirer
}

export function releaseSingleton() {
  try {
    const pid = parseInt(readFileSync(RESUMER_LOCK, 'utf-8'), 10);
    if (pid === process.pid) unlinkSync(RESUMER_LOCK);
  } catch { /* already gone */ }
}

// Exponential backoff between failed resume attempts: 1m, 2m, 4m, 8m … capped
// at 30m. Without it, a due record whose resetAt already passed retries every
// poll tick and burns all MAX_RESUME_ATTEMPTS in ~2 minutes (observed).
// A transient hook-spawned resumer keeps holding the singleton lock through
// the backoff window — intentional, and consistent with it holding the lock
// through a multi-hour reset wait (the daemon politely waits either way).
export function retryBackoffMs(attempts, { baseMs = 60_000, maxMs = 1_800_000 } = {}) {
  return Math.min(baseMs * 2 ** Math.max(0, attempts - 1), maxMs);
}

// Waiting behind a legitimately-held lock is normal (a transient hook-spawned
// resumer riding out a long reset); logging it every 30s tick for hours is
// not. First tick, then every 30th (~15 min).
export function shouldLogLockWait(n) {
  return n === 1 || n % 30 === 0;
}

// Due sessions that are actually allowed to dispatch: everything when
// autoResume is on; only explicitly `resume-now`-marked (manual) records when
// it's off. Stops stay tracked either way.
export function dueForDispatch(now = Date.now()) {
  const auto = getConfig('autoResume');
  // workspaceHold: guarded sessions wait for an explicit resume-now (manual).
  return dueSessions(now).filter(s => (auto || s.manual) && (!s.workspaceHold || s.manual));
}

function selfCommand() {
  return process.env.UNSNOOZE_SELF
    ? [process.env.UNSNOOZE_SELF]
    : [process.execPath, UNSNOOZE_BIN];
}

export function resolveRecordMux(rec) {
  return getMultiplexer(rec.mux, { owner: rec.paneOwner });
}

const stopEpisodeAt = rec => rec?.bannerAt ?? rec?.detectedAt;

// Newer non-error parent-context Claude usage proves that a user/provider retry
// already made progress after this stop. Banner absence alone does not.
function claudeProgressedAfterStop(rec, agent) {
  const cutoff = stopEpisodeAt(rec);
  return agent.id === 'claude' && hasClaudeParentUsageAfter(rec, cutoff);
}

// Compare-and-set for one stop episode, with an applied result for callers
// that must suppress stale logs, notifications, or follow-up actions.
function transitionStopEpisode(rec, status, extra = {}, {
  expect = ['stopped', 'resuming'],
} = {}) {
  const cutoff = stopEpisodeAt(rec);
  let applied = false;
  updateState(state => {
    const current = state.sessions[rec.key];
    if (!current || !expect.includes(current.status)
      || stopEpisodeAt(current) !== cutoff) return state;
    Object.assign(current, extra, { status });
    if (status !== 'resuming') current.resumeEpisodeAt = null;
    applied = true;
    return state;
  });
  return applied;
}

// Reconcile durable progress without letting a stale snapshot clear a newer
// stop episode. A false return means no progress was observed; true means this
// dispatch must stop, whether the transition applied or the snapshot went stale.
function finishIfClaudeProgressed(rec, agent) {
  if (!claudeProgressedAfterStop(rec, agent)) return false;
  const cutoff = stopEpisodeAt(rec);
  let applied = false;
  updateState(state => {
    const current = state.sessions[rec.key];
    if (current?.status === 'stopped'
      && stopEpisodeAt(current) === cutoff) {
      Object.assign(current, {
        status: 'resumed', lastAttemptAt: Date.now(), bannerCleared: true,
        lastError: null, verifyRetries: 0, resumeEpisodeAt: null,
      });
      applied = true;
    }
    return state;
  });
  log(applied
    ? `${rec.key}: newer non-error parent-context usage recorded — no wake sent`
    : `${rec.key}: stop episode changed during progress check — stale dispatch skipped`);
  return true;
}

function samePaneTarget(a, b) {
  return !!(a?.pane && b?.pane
    && a.mux === b.mux && a.paneOwner === b.paneOwner && a.pane === b.pane
    && a.agent === b.agent && a.cwd === b.cwd
    // A different non-null lease is a different pane generation. Missing
    // legacy leases only coalesce with each other; they cannot overrule a
    // record whose current generation is demonstrable.
    && (a.leaseId ?? null) === (b.leaseId ?? null));
}

function newerStop(a, b) {
  const aCutoff = stopEpisodeAt(a) ?? 0;
  const bCutoff = stopEpisodeAt(b) ?? 0;
  if (aCutoff !== bCutoff) return aCutoff > bCutoff ? a : b;
  if ((a.detectedAt ?? 0) !== (b.detectedAt ?? 0)) {
    return (a.detectedAt ?? 0) > (b.detectedAt ?? 0) ? a : b;
  }
  if (!!a.sessionId !== !!b.sessionId) return a.sessionId ? a : b;
  return String(a.key).localeCompare(String(b.key)) >= 0 ? a : b;
}

function paneStopOwner(rec, state = readState()) {
  if (!rec?.pane) return rec;
  const contenders = Object.values(state.sessions).filter(s =>
    ['stopped', 'resuming'].includes(s.status) && samePaneTarget(s, rec));
  return contenders.reduce((latest, candidate) => newerStop(latest, candidate), rec);
}

// Atomically own this exact stop before the irreversible pane/window action.
// One live pane can accept one wake. Legacy/subagent detections outside the
// short ingest-dedupe window are therefore collapsed here: the newest active
// stop owns the target and older active records become explicit history.
function claimStopForResume(rec) {
  const cutoff = stopEpisodeAt(rec);
  let claimed = false;
  updateState(state => {
    const current = state.sessions[rec.key];
    if (current?.status !== 'stopped'
      || stopEpisodeAt(current) !== cutoff) return state;

    const contenders = current.pane
      ? Object.values(state.sessions).filter(s => ['stopped', 'resuming'].includes(s.status)
        && samePaneTarget(s, current))
      : [current];
    const owner = paneStopOwner(current, state);
    const now = Date.now();
    for (const candidate of contenders) {
      if (candidate.key === owner.key) continue;
      Object.assign(candidate, {
        status: 'cancelled', lastAttemptAt: now, verifyRetries: 0,
        resumeEpisodeAt: null,
        lastError: `superseded by newer stop ${owner.key} on the same pane`,
      });
    }
    if (owner.key === current.key && current.status === 'stopped') {
      Object.assign(current, {
        status: 'resuming', lastAttemptAt: now, lastError: null, verifyRetries: 0,
        resumeEpisodeAt: cutoff,
      });
      claimed = true;
    }
    return state;
  });
  return claimed;
}

// Join the session the pane lived in only if it is still alive; otherwise the
// daemon gets its own session. It must never CREATE the launcher's base name.
export async function reviveTarget(mux, rec) {
  const named = rec.muxSession ?? rec.tmuxSession;
  if (named && typeof mux.sessionExists === 'function') {
    try {
      if (await mux.sessionExists(named)) return named;
    } catch { /* fall through to resume session */ }
  }
  return RESUME_SESSION_NAME;
}

function reopenEnv(rec, leaseId, target) {
  const env = { ...(rec.env || {}) };
  env.UNSNOOZE_MUX = rec.mux;
  // tmux pane ids are server-global — paneOwner is always null there. Only
  // zellij and herdr need UNSNOOZE_PANE_OWNER so bind() can address the right session.
  if (rec.mux === 'zellij' || rec.mux === 'herdr') {
    env.UNSNOOZE_PANE_OWNER = target || rec.paneOwner || rec.muxSession || '';
  }
  env.UNSNOOZE_LEASE_ID = leaseId;
  return env;
}

async function driveMenu(mux, pane, agent, text) {
  const steps = agent.menu.stepsToWait(text, PANE_SCAN_LINES);
  if (steps === null) return false;
  const key = steps > 0 ? 'Down' : 'Up';
  for (let i = 0; i < Math.abs(steps); i++) await mux.sendKey(pane, key);
  await mux.sendKey(pane, 'Enter');
  return true;
}

// §4: when a fallback record is due, re-capture the pane (or transcript) and
// either resume (banner gone) or reschedule the next probe with backoff.
// Returns null when the caller should proceed with a normal dispatch.
export async function probeFallback(rec, {
  mux = resolveRecordMux(rec),
  now = Date.now(),
} = {}) {
  if (rec.resetSource !== 'fallback' || rec.manual) return null;
  const key = rec.key;
  const agent = getAgent(rec.agent);
  let stillLimited = null;
  let resetLine = null;
  let bannerAt = rec.bannerAt ?? null;

  // Prefer a fresh transcript entry when available (claude).
  const fromTx = latestRateLimitFromTranscript(rec.cwd, rec.sessionId, {
    now, claudeDir: rec.env?.CLAUDE_CONFIG_DIR,
  });
  if (fromTx) {
    stillLimited = true;
    resetLine = fromTx.resetLine;
    bannerAt = fromTx.timestampMs;
  } else if (rec.pane && await mux.paneAlive(rec.pane)) {
    let text;
    try { text = await mux.capturePane(rec.pane, CAPTURE_LINES); }
    catch (err) {
      log(`${key}: probe capture failed: ${err.message}`);
      return rescheduleProbe(rec, now);
    }
    const d = detectLimit(text, PANE_SCAN_LINES, agent.patterns);
    const menu = !!(agent.menu && agent.menu.isPrompt(text, PANE_SCAN_LINES));
    stillLimited = d.hit || menu;
    resetLine = d.hit ? d.resetLine : null;
  } else {
    // No live signal — treat as still unknown and probe again (or give up
    // at the hard ceiling and let reopen try).
    return rescheduleProbe(rec, now);
  }

  if (!stillLimited) {
    // Banner cleared — proceed with a normal wake.
    log(`${key}: probe found banner cleared — resuming`);
    return null;
  }

  // Banner still present. If it now parses to a real time, upgrade off fallback.
  if (resetLine) {
    const { at, source } = resetAtMs(parseResetTime(resetLine), {
      marginMs: RESET_MARGIN_MS,
      fallbackMs: PROBE_INTERVAL_MS,
      now: new Date(now),
      bannerAt,
    });
    if (source !== 'fallback') {
      const applied = transitionStopEpisode(rec, 'stopped', {
        resetAt: at, resetSource: source, bannerAt,
        lastError: 'limit still active (probe upgraded estimate)',
        probeCount: 0,
      }, { expect: ['stopped'] });
      if (!applied) return 'stale';
      log(`${key}: probe upgraded fallback→${source}, rescheduled to ${new Date(at).toISOString()}`);
      return 'probe';
    }
  }

  return rescheduleProbe(rec, now);
}

function rescheduleProbe(rec, now = Date.now()) {
  const key = rec.key;
  const probeCount = rec.probeCount || 0;
  const detectedAt = rec.detectedAt || now;
  const ceiling = detectedAt + FALLBACK_RESET_MS + RESET_MARGIN_MS;
  // Past the hard ceiling: schedule a final attempt at the ceiling (or now
  // if already past) and stop tagging as endless probes — reopen path runs.
  if (now >= ceiling) {
    // A model limit is lifted by a human choice (switch models, add credits),
    // never by waiting it out. Typing a wake into it would hit the same wall,
    // so make the stall a visible terminal state instead of a futile resume.
    if (rec.limitType === 'model') {
      setStatus(key, 'failed', {
        lastError: 'model limit still active — switch models (/model) or add credits',
        probeCount: probeCount + 1,
      }, { expect: ['stopped'] });
      log(`${key}: model limit still active at probe ceiling — needs a human`);
      notify('unsnooze: model limit needs you ⚠️',
        `${rec.cwd}: still limited after probing — /model to switch or /usage-credits`,
        { context: ctxOf(rec), priority: 4 });
      return 'held';
    }
    const applied = transitionStopEpisode(rec, 'stopped', {
      resetAt: now,
      resetSource: 'fallback',
      lastError: 'probe ceiling reached — attempting resume',
      probeCount: probeCount + 1,
    }, { expect: ['stopped'] });
    if (!applied) return 'stale';
    log(`${key}: probe ceiling reached — attempting resume`);
    return null;   // proceed with dispatch
  }
  const delay = nextProbeDelayMs(probeCount, {
    intervalMs: PROBE_INTERVAL_MS, maxMs: PROBE_MAX_MS,
  });
  let nextAt = now + delay + RESET_MARGIN_MS;
  if (nextAt > ceiling) nextAt = ceiling;
  const applied = transitionStopEpisode(rec, 'stopped', {
    resetAt: nextAt,
    resetSource: 'fallback',
    lastError: 'limit still active — probing',
    probeCount: probeCount + 1,
  }, { expect: ['stopped'] });
  if (!applied) return 'stale';
  log(`${key}: probe #${probeCount + 1} rescheduled to ${new Date(nextAt).toISOString()}`);
  return 'probe';
}

// --- shared decision core (dispatchOne acts on it, planFor narrates it) -----
// These helpers are DECISION-ONLY: no state writes, no notifications, no
// keystrokes. `unsnooze preview` reuses them verbatim, so the dry-run cannot
// drift from what dispatch actually does.

// Workspace guard: returns the (possibly suffixed) message, or a hold.
export function evaluateWorkspaceGuard(rec, message, { fingerprint = workspaceFingerprint } = {}) {
  const mode = getConfig('workspaceGuard');
  if (!rec.workspace || mode === 'off' || rec.manual) return { message, hold: null, informed: null };
  const change = workspaceChanged(rec, fingerprint(rec.cwd));
  if (!change) return { message, hold: null, informed: null };
  const desc = describeChange(change);
  if (mode === 'pause') return { message, hold: { reason: `workspace changed (${desc})`, desc }, informed: null };
  return {
    message: message + `\n\nHeads up: this workspace changed while the session was stopped (${desc}). Re-read the current state of the repo before continuing.`,
    hold: null,
    informed: desc,
  };
}

// Context-size guard: returns a hold, an inform note, or neither.
export function evaluateContextGuard(rec, agent, { contextTokens = null } = {}) {
  const mode = getConfig('contextGuard');
  if (mode === 'off' || rec.manual) return { hold: null, note: null, tokens: null };
  const estimate = contextTokens
    ?? (typeof agent.contextTokens === 'function' ? r => agent.contextTokens(r) : null);
  let tokens = null;
  try { tokens = estimate ? estimate(rec) : null; } catch { tokens = null; }
  if (tokens == null || tokens < getConfig('contextGuardTokens')) return { hold: null, note: null, tokens };
  const size = approxTokens(tokens);
  if (mode === 'pause') return { hold: { reason: `context ${size} tokens`, size }, note: null, tokens };
  return {
    hold: null,
    note: `${rec.cwd}: waking a ${size}-token session — its full context is re-read at full (uncached) price`,
    tokens,
  };
}

// Read-only live-pane classification: liveness, busy/menu/idle content, and
// the identity/liveness ownership triad. Never sends anything.
export async function assessPane(rec, agent, { mux, matchesLease = leaseMatches } = {}) {
  if (!rec.pane) return { alive: false };
  let alive = false;
  try { alive = await mux.paneAlive(rec.pane); } catch { alive = false; }
  if (!alive) return { alive: false };
  let text;
  try { text = await mux.capturePane(rec.pane, CAPTURE_LINES); }
  catch (err) { return { alive: true, captureError: err.message }; }
  const busy = isBusy(text, agent.patterns.busyPatterns);
  const d = detectLimit(text, PANE_SCAN_LINES, agent.patterns);
  const menu = !!(agent.menu && agent.menu.isPrompt(text, PANE_SCAN_LINES));
  let cmd = null;
  try { cmd = await mux.paneCurrentCommand?.(rec.pane); }
  catch (err) { log(`${rec.key}: pane command lookup failed: ${err.message}`); }
  const contentOwned = menu || d.hit || agent.patterns.idleRegex.test(text);
  // Two independent questions, both required before touching the pane:
  //   identity — is this pane still OURS? (stamp/lease; false VETOES)
  //   liveness — is our agent still RUNNING in it? (lease pid+birth, or the
  //     foreground command; the stamp alone never counts — it outlives the
  //     agent and the pane may now be the user's shell.)
  const identity = await paneOwnedByRecord(rec, { mux, matchesLease });
  const leased = await matchesLease(rec, { mux });
  const owned = identity !== false && (leased || agent.isForegroundCommand(cmd));
  const authorized = owned && contentOwned;
  return { alive: true, text, busy, d, menu, cmd, contentOwned, identity, leased, owned, authorized };
}

// Dry-run: what WOULD dispatch do with this record right now, and why.
// Read-only pane captures only — never mutates state, types, or opens panes.
export async function planFor(rec, {
  mux = resolveRecordMux(rec), matchesLease = leaseMatches,
  fingerprint = workspaceFingerprint, contextTokens = null, now = Date.now(),
} = {}) {
  const agent = getAgent(rec.agent);
  const gates = [];
  const base = { key: rec.key, sessionId: rec.sessionId, agent: agent.id, cwd: rec.cwd, status: rec.status, gates };

  if (rec.status !== 'stopped') {
    if (rec.status === 'resuming') {
      gates.push('resume in flight — the next tick verifies the outcome');
      return { ...base, action: 'verifying' };
    }
    gates.push(`status ${rec.status} — nothing to dispatch`);
    return { ...base, action: 'none' };
  }
  if (claudeProgressedAfterStop(rec, agent)) {
    gates.push('newer non-error parent-context usage shows that the session already resumed');
    return { ...base, action: 'none' };
  }
  const paneOwner = paneStopOwner(rec);
  if (paneOwner?.key !== rec.key) {
    gates.push(`newer active stop ${paneOwner.key} owns this live pane target`);
    return { ...base, action: 'none' };
  }
  // Gate order mirrors runResumer exactly: give-up only ever happens to
  // records that pass dueForDispatch (due AND auto-or-manual AND not held),
  // so paused/held/backing-off records are narrated as such even when their
  // attempt counter is maxed — dispatch is genuinely still waiting on them.
  if (!getConfig('autoResume') && !rec.manual) {
    gates.push('paused — autoResume is off (`unsnooze resume-now` overrides)');
    return { ...base, action: 'paused' };
  }
  if (rec.workspaceHold && !rec.manual) {
    gates.push(`held: ${rec.holdReason ?? 'guard hold'} — \`unsnooze resume-now\` wakes it`);
    return { ...base, action: 'held' };
  }
  const isProbe = rec.resetSource === 'fallback' && !rec.manual;
  if ((rec.resetAt || 0) > now) {
    gates.push(`not due — ${isProbe ? 'next probe' : 'resets'} ${new Date(rec.resetAt).toLocaleString()}`);
    if (isProbe) gates.push('reset time unknown — cheap pane probes stand in for a schedule');
    return { ...base, action: isProbe ? 'probe' : 'waiting', at: rec.resetAt };
  }
  if ((rec.attempts || 0) >= MAX_RESUME_ATTEMPTS) {
    gates.push(`attempts ${rec.attempts}/${MAX_RESUME_ATTEMPTS} exhausted — would be marked failed (re-arms on a fresh detection)`);
    return { ...base, action: 'give-up' };
  }
  if (isProbe) {
    // Past the hard ceiling, rescheduleProbe deterministically stops probing
    // and dispatch falls through to a REAL wake — narrate that, not a probe.
    const ceiling = (rec.detectedAt || now) + FALLBACK_RESET_MS + RESET_MARGIN_MS;
    if (now < ceiling) {
      gates.push('reset time unknown — would probe the pane/transcript before any resume (a cleared banner resumes immediately)');
      return { ...base, action: 'probe', at: rec.resetAt };
    }
    gates.push('probe ceiling reached — probing is over, a real resume follows');
  }

  // Same message precedence and guard evaluation dispatch uses.
  let message = rec.resumeMessage ?? resolveResumeMessage(agent.id);
  const ws = evaluateWorkspaceGuard(rec, message, { fingerprint });
  if (ws.hold) {
    gates.push(`would hold: ${ws.hold.reason} (workspaceGuard=pause)`);
    return { ...base, action: 'held' };
  }
  message = ws.message;
  if (ws.informed) gates.push(`workspace changed (${ws.informed}) — the wake message warns the agent`);
  const ctx = evaluateContextGuard(rec, agent, { contextTokens });
  if (ctx.hold) {
    gates.push(`would hold: ${ctx.hold.reason} (contextGuard=pause)`);
    return { ...base, action: 'held' };
  }
  if (ctx.note) gates.push(`big-context wake: ~${approxTokens(ctx.tokens)} tokens re-read at full (uncached) price`);

  // Same live-pane classification dispatch uses.
  const a = await assessPane(rec, agent, { mux, matchesLease });
  if (a.alive) {
    if (a.captureError) {
      gates.push(`pane capture failed (${a.captureError}) — dispatch would record the error and retry with backoff`);
      return { ...base, action: 'retry', target: { pane: rec.pane } };
    }
    if (a.busy) {
      gates.push('agent is mid-work (busy footer) — dispatch defers, never interrupts');
      return { ...base, action: 'busy', target: { pane: rec.pane } };
    }
    if (a.menu && a.authorized) {
      if (!getConfig('menuAutoAnswer')) {
        gates.push('limit menu on screen but menuAutoAnswer is off — would wait for you');
        return { ...base, action: 'menu-held', target: { pane: rec.pane } };
      }
      return { ...base, action: 'drive-menu', target: { pane: rec.pane } };
    }
    if (a.authorized) return { ...base, action: 'inject', target: { pane: rec.pane }, message };
    if (a.owned && !a.menu) {
      gates.push('pane is ours but not at an idle prompt — dispatch defers');
      return { ...base, action: 'busy', target: { pane: rec.pane } };
    }
    if (a.identity === false) gates.push('pane id was recycled — demonstrably not ours anymore');
    else gates.push('pane content/ownership unproven — no keystrokes allowed');
  } else if (rec.pane) {
    gates.push('original pane is gone');
  } else {
    gates.push('no pane recorded (GUI/transcript detection)');
  }

  // Same rule dispatch applies: only one anonymous record per agent+project
  // may revive, or they all revive the same conversation.
  const superseded = supersedingAnonymousRecord(rec);
  if (superseded) {
    gates.push(`another record (${superseded.key}) covers the same agent and project, and neither`
      + ' knows its session id — reviving both would clone the conversation');
    return { ...base, action: 'superseded', target: { key: superseded.key } };
  }
  const target = await reviveTarget(mux, rec);
  const resume = agent.resumeArgs(rec.sessionId, message);
  return {
    ...base, action: 'reopen', target: { session: target }, message,
    argv: [agent.id, ...resume.args, ...resolveResumeExtraArgs(agent.id)],
    messageViaPane: !!resume.messageViaPane,
  };
}

// Ordered safety decision. Returns: already-resumed | busy | retry | progress |
// held | injected | reopen | probe.
export async function dispatchOne(rec, {
  mux = resolveRecordMux(rec), resolveMux = null,
  resumeMessage, selfCmd = selfCommand(), fingerprint = workspaceFingerprint,
  notifier = notify, matchesLease = leaseMatches, contextTokens = null,
} = {}) {
  resolveMux ||= () => mux;
  const key = rec.key;
  const agent = getAgent(rec.agent);
  // Cheap early reconciliation; this is repeated after asynchronous pane or
  // multiplexer inspection, immediately before any keystroke/window launch.
  if (finishIfClaudeProgressed(rec, agent)) return 'already-resumed';
  // Wake-message precedence: per-session (`unsnooze message <id> "..."`) →
  // explicit option → per-agent (`resumeMessages.<id>`) → global. Applies to
  // both the live-pane sendText and the argv reopen path.
  resumeMessage = rec.resumeMessage ?? resumeMessage ?? resolveResumeMessage(agent.id);

  // §4: fallback records probe cheaply before a real resume attempt.
  if (rec.resetSource === 'fallback' && !rec.manual) {
    const episode = stopEpisodeAt(rec);
    const probed = await probeFallback(rec, { mux });
    if (probed != null) return probed;
    // null → banner gone or ceiling hit — fall through to normal dispatch.
    // Re-read only this episode in case the ceiling probe updated its fields.
    // A newer stop may not inherit the old episode's due decision.
    const current = readState().sessions[key];
    if (!current || current.status !== 'stopped' || stopEpisodeAt(current) !== episode) {
      return 'stale';
    }
    rec = current;
  }

  // Stale-workspace guard: another session (or a human) may have moved the
  // repo while this one slept. Manual resumes (resume-now) always proceed.
  // Decision comes from the shared evaluator (planFor uses the same one);
  // dispatch owns the side effects.
  const ws = evaluateWorkspaceGuard(rec, resumeMessage, { fingerprint });
  if (ws.hold) {
    if (!transitionStopEpisode(rec, 'stopped', {
      workspaceHold: true, holdReason: ws.hold.reason,
    }, { expect: ['stopped'] })) return 'stale';
    notifier('unsnooze: session held', `${rec.cwd}: workspace changed while stopped (${ws.hold.desc}) — run: unsnooze resume-now`, { context: ctxOf(rec) });
    log(`${key}: workspace changed (${ws.hold.desc}) — held (workspaceGuard=pause)`);
    return 'held';
  }
  if (ws.informed) log(`${key}: workspace changed (${ws.informed}) — informing agent in the wake message`);
  resumeMessage = ws.message;

  // Context-size guard: the prompt cache expired hours ago, so the first wake
  // message re-reads the session's entire context at full (uncached) price.
  // `pause` holds big sessions, `inform` notifies the user — but only once
  // the wake actually lands, since dispatchOne re-runs on every busy/retry
  // tick. Manual resumes proceed.
  const ctx = evaluateContextGuard(rec, agent, { contextTokens });
  if (ctx.hold) {
    if (!transitionStopEpisode(rec, 'stopped', {
      workspaceHold: true, holdReason: ctx.hold.reason,
    }, { expect: ['stopped'] })) return 'stale';
    notifier('unsnooze: session held', `${rec.cwd}: waking would re-read ${ctx.hold.size} tokens of context at full (uncached) price — run: unsnooze resume-now`, { context: ctxOf(rec) });
    log(`${key}: context ${ctx.hold.size} tokens ≥ threshold — held (contextGuard=pause)`);
    return 'held';
  }
  const contextNote = ctx.note;
  if (contextNote) log(`${key}: context ${approxTokens(ctx.tokens)} tokens — informing (contextGuard=inform)`);
  const notifyContext = () => {
    if (contextNote) notifier('unsnooze: big-context wake', contextNote, { context: ctxOf(rec) });
  };
  const reopenGuarded = () =>
    reopen(rec, { mux, resolveMux, agent, resumeMessage, selfCmd, onDelivered: notifyContext });

  // Live-pane path: classification comes from the shared assessPane (planFor
  // narrates the identical assessment); dispatch owns every side effect.
  const a = await assessPane(rec, agent, { mux, matchesLease });
  if (a.alive) {
    if (a.captureError) {
      if (!transitionStopEpisode(rec, 'stopped', {
        lastError: `capture: ${a.captureError}`,
      }, { expect: ['stopped'] })) return 'stale';
      return 'retry';
    }
    if (a.busy) return 'busy';
    if (a.menu) {
      if (finishIfClaudeProgressed(rec, agent)) return 'already-resumed';
      if (!a.authorized) return reopenGuarded();
      if (!getConfig('menuAutoAnswer')) return 'held';
      // Menu navigation is an irreversible pane action too. Claim the exact
      // stop after assessment so a refreshed episode cannot receive stale
      // Down/Enter keystrokes.
      if (!claimStopForResume(rec)) return 'stale';
      try {
        if (await driveMenu(mux, rec.pane, agent, a.text)) return 'progress';
        transitionStopEpisode(rec, 'stopped', {
          lastError: 'menu drive: wait option unavailable',
        }, { expect: ['resuming'] });
      } catch (err) {
        transitionStopEpisode(rec, 'stopped', {
          lastError: `menu drive: ${err.message}`,
        }, { expect: ['resuming'] });
      }
      return 'retry';
    }
    if (a.authorized) {
      // assessPane is asynchronous. Close the final human/provider-resume race
      // after assessment and immediately before the keystroke.
      if (finishIfClaudeProgressed(rec, agent)) return 'already-resumed';
      if (!claimStopForResume(rec)) return 'stale';
      await mux.sendText(rec.pane, resumeMessage);
      log(`${key}: sent continue via ${rec.mux} ${rec.paneOwner ?? '-'}:${rec.pane}`);
      notifyContext();
      return 'injected';
    }
    if (a.owned) return 'busy';
  }

  return reopenGuarded();
}

// onDelivered fires only when the resume message actually reached the agent
// (argv or typed) — not on ready-timeouts or a still-active limit banner.
// Which other record would revive the same conversation as this one.
//
// Every agent's no-session-id resume means the same thing: continue the newest
// session in this cwd (`claude -c`, `codex resume --last`, `qwen --continue`,
// and so on). One anonymous record revives that conversation; N of them revive
// N copies of it into the same repo — a weekly reset turned 23 accumulated
// records into roughly 8 parallel clones in production.
//
// So the rule is not "anonymous records may not reopen": Grok never has a
// session id at all, and blocking anonymity outright would disable it. The
// rule is that at most ONE anonymous record per agent+project may reopen. The
// newest wins, deterministically (key breaks a tie), so preview and dispatch
// always choose the same one.
export function supersedingAnonymousRecord(rec, state = readState()) {
  if (!rec || rec.sessionId) return null;
  const stamp = r => (r.bannerAt ?? r.detectedAt ?? 0);
  const rivals = Object.values(state.sessions || {}).filter(other =>
    other && other.key !== rec.key && !other.sessionId
    && other.agent === rec.agent && other.cwd === rec.cwd
    && ['stopped', 'resuming'].includes(other.status));
  return rivals.find(other =>
    stamp(other) > stamp(rec)
    || (stamp(other) === stamp(rec) && String(other.key) > String(rec.key))) || null;
}

async function reopen(rec, { mux, resolveMux, agent, resumeMessage, selfCmd, onDelivered = () => {} }) {
  const key = rec.key;
  const cutoff = rec.bannerAt ?? rec.detectedAt;
  // Anonymous records cannot be told apart, so only one of them may revive.
  const superseded = supersedingAnonymousRecord(rec);
  if (superseded) {
    setStatus(key, 'failed', {
      lastError: `superseded by ${superseded.key} — same agent and project, and neither record`
        + ' knows its session id, so reviving both would clone the conversation',
      verifyRetries: 0,
    }, { expect: ['stopped', 'resuming'], expectCutoff: cutoff });
    log(`${key}: reopen skipped — superseded by ${superseded.key} (anonymous record for the same project)`);
    return 'skipped';
  }
  const resume = agent.resumeArgs(rec.sessionId, resumeMessage);
  const leaseId = createLeaseId();
  const target = await reviveTarget(mux, rec);
  const launchSpec = {
    file: selfCmd[0], args: [...selfCmd.slice(1), '_run', agent.id, ...resume.args, ...resolveResumeExtraArgs(agent.id)],
    env: reopenEnv(rec, leaseId, target),
  };
  // reviveTarget can await a multiplexer query. Recheck after it and claim the
  // exact episode immediately before opening a new pane.
  if (finishIfClaudeProgressed(rec, agent)) return 'already-resumed';
  if (!claimStopForResume(rec)) return 'stale';
  let address;
  try {
    address = await mux.newWindow(target, rec.cwd || homedir(), launchSpec);
  } catch (err) {
    // Log it — a revival that cannot even spawn the multiplexer (e.g. tmux
    // ENOENT under launchd's bare PATH) otherwise fails 5 times in total
    // silence, with the only evidence buried in a soon-swept record.
    log(`${key}: new-window failed in session "${target}": ${err.message}`);
    setStatus(key, 'stopped', {
      attempts: (rec.attempts || 0) + 1,
      lastError: `new-window: ${err.message}`,
      verifyRetries: 0, resumeEpisodeAt: null,
    }, { expect: ['resuming'], expectCutoff: cutoff });
    return 'retry';
  }
  // Stamp the fresh pane as ours (best-effort; tmux only) so later close /
  // inject decisions can prove identity even after the agent process exits.
  // A backend may revive into a different session than we asked for — herdr
  // refuses to restart a stopped one and picks a free name instead. `session`
  // is that answer; it is not part of the pane address and must not reach state.
  // `?? {}` because every use of the address below this point was written
  // defensively (`address?.pane`) and a backend returning nothing must keep
  // degrading rather than throwing here.
  const { session: usedSession = target, ...address2 } = address ?? {};
  address = address2;
  const stamper = typeof mux.bind === 'function' ? mux.bind(address.paneOwner ?? usedSession) : mux;
  if (address?.pane && typeof stamper.stampPaneOwner === 'function') {
    try { await stamper.stampPaneOwner(address.pane, leaseId); } catch { /* legacy tmux */ }
  }
  // Persist the session the pane actually lives in, so future joins and attach
  // hints name something the user can really attach to.
  updateState(state => {
    const s = state.sessions[key];
    if (s?.status === 'resuming' && (s.bannerAt ?? s.detectedAt) === cutoff) {
      Object.assign(s, address, { leaseId, muxSession: usedSession });
    }
    return state;
  });
  const rebound = { ...rec, ...address, leaseId, muxSession: usedSession };
  mux = resolveMux(rebound);
  log(`${key}: re-opened via ${rec.mux} ${address.paneOwner ?? '-'}:${address.pane} in session ${usedSession}`);

  // The resume prompt traveled in argv (e.g. `codex resume <id> "msg"`) —
  // nothing to type into the TUI; verifyOne checks the outcome later.
  if (!resume.messageViaPane) { onDelivered(); return 'reopen'; }

  // Wait for the TUI to be ready (input prompt visible), then send the message.
  const outcome = await awaitReadyAndSend(mux, address.pane, agent, resumeMessage);
  if (outcome === 'limit') {
    // Limit hadn't actually reset — the fresh session hit it immediately.
    return 'reopen';
  }
  if (outcome === 'sent') {
    log(`${key}: resume message sent to new pane ${address.pane}`);
    onDelivered();
    return 'reopen';
  }
  setStatus(key, 'stopped', {
    attempts: (rec.attempts || 0) + 1,
    lastError: 'ready timeout',
    verifyRetries: 0, resumeEpisodeAt: null,
  }, { expect: ['resuming'], expectCutoff: cutoff });
  return 'retry';
}

// The reopen ready-wait loop, extracted so other launch paths (e.g. a fresh
// session with no prior sessionId) can reuse the identical wait-then-type
// behavior. Pure move from reopen(): same 2s poll cadence, same
// capturePane-throws-continue, same limit/idle detection.
export async function awaitReadyAndSend(mux, pane, agent, message, {
  timeoutMs = READY_TIMEOUT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    let text;
    try { text = await mux.capturePane(pane, CAPTURE_LINES); }
    catch { continue; }
    if ((agent.menu && agent.menu.isPrompt(text, PANE_SCAN_LINES)) || detectLimit(text, PANE_SCAN_LINES, agent.patterns).hit) {
      return 'limit';
    }
    // The idle input box: a prompt glyph with no busy footer.
    if (!isBusy(text, agent.patterns.busyPatterns) && agent.patterns.idleRegex.test(text)) {
      await mux.sendText(pane, message);
      return 'sent';
    }
  }
  return 'timeout';
}

function recordVerifyRetry(rec, lastError) {
  const verifyRetries = (rec.verifyRetries || 0) + 1;
  let applied;
  if (verifyRetries >= MAX_VERIFY_RETRIES) {
    const attempts = (rec.attempts || 0) + 1;
    applied = transitionStopEpisode(rec, 'stopped', {
      attempts,
      // Same backoff (and same manual exemption) as routed retries.
      resetAt: rec.manual ? Date.now() : Date.now() + retryBackoffMs(attempts),
      lastError,
      verifyRetries: 0, resumeEpisodeAt: null,
    }, { expect: ['resuming'] });
  } else {
    applied = transitionStopEpisode(rec, 'resuming', { lastError, verifyRetries },
      { expect: ['resuming'] });
  }
  if (!applied) releaseSupersededResume(rec.key);
  return applied ? 'retry' : 'stale';
}

function releaseSupersededResume(key) {
  const current = readState().sessions[key];
  if (!current || current.status !== 'resuming' || current.resumeEpisodeAt == null
    || stopEpisodeAt(current) === current.resumeEpisodeAt) return false;
  return transitionStopEpisode(current, 'stopped', {
    lastError: 'newer limit detected during resume', verifyRetries: 0,
    resumeEpisodeAt: null,
  }, { expect: ['resuming'] });
}

// Post-dispatch verification: did the limit banner come back?
export async function verifyOne(key, { resolveMux = resolveRecordMux } = {}) {
  const rec = readState().sessions[key];
  if (!rec || rec.status !== 'resuming') return;
  // A detection that lands after the action claim deliberately preserves the
  // in-flight status, but it advances bannerAt/detectedAt. Do not verify that
  // newer episode using an older pane action.
  if (releaseSupersededResume(key)) return 'stale';
  const agent = getAgent(rec.agent);
  if (!rec.pane) {
    return recordVerifyRetry(rec, 'verify: pane unavailable');
  }
  const mux = resolveMux(rec);
  let text;
  try { text = await mux.capturePane(rec.pane, CAPTURE_LINES); }
  catch (err) {
    return recordVerifyRetry(rec, `verify capture: ${err.message}`);
  }
  const d = detectLimit(text, PANE_SCAN_LINES, agent.patterns);
  if (d.hit || (agent.menu && agent.menu.isPrompt(text, PANE_SCAN_LINES))) {
    // Limit not actually reset — reschedule from the fresh banner.
    // Prefer a dated transcript entry when present so relative/absolute
    // offsets anchor to the banner's own time.
    let resetLine = d.hit ? d.resetLine : null;
    let bannerAt = null;
    const fromTx = latestRateLimitFromTranscript(rec.cwd, rec.sessionId, {
      claudeDir: rec.env?.CLAUDE_CONFIG_DIR,
    });
    if (fromTx) {
      resetLine = fromTx.resetLine ?? resetLine;
      bannerAt = fromTx.timestampMs;
    }
    const { at, source } = resetAtMs(parseResetTime(resetLine), {
      marginMs: RESET_MARGIN_MS,
      fallbackMs: PROBE_INTERVAL_MS,
      bannerAt,
    });
    const applied = transitionStopEpisode(rec, 'stopped', {
      attempts: (rec.attempts || 0) + 1, resetAt: at, resetSource: source,
      bannerAt: bannerAt ?? rec.bannerAt ?? null,
      lastError: 'limit still active at resume time', verifyRetries: 0,
      resumeEpisodeAt: null,
      ...(source === 'fallback' ? { probeCount: (rec.probeCount || 0) + 1 } : { probeCount: 0 }),
    }, { expect: ['resuming'] });
    if (!applied) {
      releaseSupersededResume(key);
      return 'stale';
    }
    log(`${key}: limit still active, rescheduled to ${new Date(at).toISOString()} (${source})`);
    return;
  }
  if (!transitionStopEpisode(rec, 'resumed', {
    lastError: null, verifyRetries: 0, resumeEpisodeAt: null,
    bannerCleared: true,
  }, { expect: ['resuming'] })) {
    releaseSupersededResume(key);
    return 'stale';
  }
  const session = rec.muxSession || RESUME_SESSION_NAME;
  const hint = attachHint(rec.mux, session);
  log(`${key}: verified resumed in ${session}${hint ? ` — ${hint}` : ''}`);
  const fromGui = rec.origin && rec.origin !== 'cli';
  const where = hint ? ` in ${session} — attach: ${hint}` : '';
  notify('unsnoozed ✅', `${rec.cwd} is running again${where}${fromGui ? ` (was in ${rec.origin} — revived in ${rec.mux})` : ''}`, { context: ctxOf(rec) });
  return 'resumed';
}

export function routeDispatchOutcome(result, rec, deferCounts, { maxBusyDefers = MAX_BUSY_DEFERS, now = Date.now() } = {}) {
  if (result === 'busy') {
    const n = (deferCounts.get(rec.key) || 0) + 1;
    deferCounts.set(rec.key, n);
    if (n > maxBusyDefers) {
      // Busy is evidence that typing would be unsafe, not evidence that the
      // stopped episode completed. Drop the hot-loop delay after the cap but
      // leave the record stopped for the next normal poll.
      return { verify: false, waitBusy: false };
    }
    return { verify: false, waitBusy: true };
  }
  deferCounts.delete(rec.key);
  if (result === 'retry') {
    const attempts = (rec.attempts || 0) + 1;
    const episode = stopEpisodeAt(rec);
    updateState(state => {
      const current = state.sessions[rec.key];
      if (!current || !['stopped', 'resuming'].includes(current.status)) return state;
      if (stopEpisodeAt(current) !== episode) {
        // A fresh detection superseded this failed attempt. If ingest kept the
        // action marked in-flight, release it without charging the new stop.
        if (current.status === 'resuming') {
          Object.assign(current, { status: 'stopped', resumeEpisodeAt: null, verifyRetries: 0 });
        }
        return state;
      }
      Object.assign(current, {
        status: 'stopped', attempts,
        // Back off before the next attempt — a due record retried on every poll
        // tick exhausts MAX_RESUME_ATTEMPTS in minutes. Manual records are
        // exempt: `resume-now` promised an immediate wake, so a transient error
        // must not silently defer it.
        resetAt: rec.manual ? now : now + retryBackoffMs(attempts),
        lastError: current.lastError, verifyRetries: 0, resumeEpisodeAt: null,
      });
      return state;
    });
    return { verify: false, waitBusy: false };
  }
  if (result === 'progress') {
    setStatus(rec.key, 'stopped', {
      lastError: null, verifyRetries: 0, resumeEpisodeAt: null,
    }, { expect: ['resuming'] });
    return { verify: false, waitBusy: false };
  }
  if (result === 'already-resumed' || result === 'stale' || result === 'held' || result === 'probe') {
    return { verify: false, waitBusy: false };
  }
  return { verify: result === 'injected' || result === 'reopen', waitBusy: false };
}

// persistent: never exit on an empty ledger (daemon mode — `unsnooze daemon`,
// launchd/systemd). watcher: transcript watcher ticked every loop, so GUI
// sessions are detected without a hook or pane. signal: clean shutdown.
export async function runResumer({
  resolveMux = resolveRecordMux, pollInterval = POLL_INTERVAL_MS,
  persistent = false, watcher = null, signal = null, queueMux = null,
  spawner = spawnDetached, versionSkewed = hasVersionSkew, handoffBin = UNSNOOZE_BIN,
} = {}) {
  // A transient hook-spawned resumer may hold the lock right now; a daemon
  // outlives it, so wait for the lock instead of dying. The watcher MUST keep
  // ticking during the wait: it only records stops (its own state lock covers
  // that), and a stop left unread past the freshness window is lost for good.
  const tickWatcher = async () => {
    if (!watcher || !getConfig('guiWatch')) return;
    try { await watcher.tick(); } catch (err) { log(`watcher tick failed: ${err.message}`); }
  };
  let lockWaits = 0;
  while (!acquireSingleton()) {
    if (!persistent) { log('another resumer is running — exiting'); return 0; }
    if (signal?.aborted) return 0;
    await tickWatcher();
    lockWaits += 1;
    if (shouldLogLockWait(lockWaits)) log('another resumer holds the lock — daemon waiting');
    await sleep(pollInterval);
  }
  updateState(state => { state.resumerPid = process.pid; });
  // Stamp the build — a transient resumer waits out the whole reset and can
  // easily be older than the package on disk. See the monitor's start line.
  log(`resumer started (pid ${process.pid}${persistent ? ', persistent' : ''}, unsnooze ${PKG_VERSION})`);
  const deferCounts = new Map();

  try {
    for (;;) {
      if (signal?.aborted) { log('shutdown requested — resumer exiting'); return 0; }

      // Version-skew hand-off. A transient resumer is spawned at the stop and
      // waits out the whole reset — hours — so an `npm i -g` landing mid-wait
      // leaves the process that SENDS THE WAKE running deleted code. Nothing
      // supervises it, so it replaces itself. The daemon is exempt: launchd/
      // systemd own its restart and bin/unsnooze.js already aborts it on skew;
      // forking a rival from under a supervisor would just fight the unit.
      //
      // Release the singleton BEFORE the replacement starts. acquireSingleton
      // honors a live holder, so a child that starts while we still hold the
      // lock exits on sight and we would end up with no resumer at all.
      if (!persistent && versionSkewed()) {
        const handed = await restartOnVersionSkew({
          args: ['_resumer'], spawner, skewed: () => true, log, binPath: handoffBin,
          // Released only once the hand-off is actually going ahead — never
          // for one the pre-flight already ruled out.
          beforeSpawn: () => {
            releaseSingleton();
            updateState(state => { if (state.resumerPid === process.pid) state.resumerPid = null; });
          },
        });
        if (handed) return 0;
        // Hand-off refused or failed: take the lock back rather than keep
        // resuming unlocked, where a second resumer could dispatch the same
        // record. Idempotent when beforeSpawn never ran — we still hold it.
        acquireSingleton();
        updateState(state => { state.resumerPid = process.pid; });
      }

      await tickWatcher();

      // Pre-wall usage warnings (1.13) — after watcher so samples are fresh.
      try {
        await tickUsageWarnings();
      } catch (err) {
        log(`usage warn tick failed: ${err.message}`);
      }

      // Scheduled cleanup: age prune + pane-aware sweep + abandon stale stops.
      try {
        updateState(state => { prune(state); return state; });
        await sweepRecords({ resolveMux });
        await markStaleAbandoned({ resolveMux });
        await autoReapIfEnabled({ resolveMux });
      } catch (err) {
        log(`cleanup tick failed: ${err.message}`);
      }

      // Reconcile manual/provider retries before waiting/attempt-cap decisions.
      // dispatchOne repeats this immediately before acting to close the race.
      for (const rec of activeStopped()) {
        finishIfClaudeProgressed(rec, getAgent(rec.agent));
      }

      const stopped = activeStopped();
      const resuming = Object.values(readState().sessions).filter(s => s.status === 'resuming');
      // Additive: a pending/launching prompt-queue entry keeps a transient
      // resumer alive the same way a stopped/resuming session record does —
      // this can only make the loop live LONGER, never exit earlier (the
      // original session-only condition is untouched, just AND-ed with this).
      const queuePending = readState().promptQueue.some(e => ['pending', 'launching'].includes(e.status));
      if (stopped.length === 0 && resuming.length === 0 && !queuePending && !persistent) {
        log('no pending sessions — resumer exiting');
        return 0;
      }

      const due = dueForDispatch().filter(s => (s.attempts || 0) < MAX_RESUME_ATTEMPTS);
      // Anything over the attempts cap is dead — mark failed so we can exit.
      for (const s of dueForDispatch()) {
        if ((s.attempts || 0) >= MAX_RESUME_ATTEMPTS) {
          const applied = transitionStopEpisode(s, 'failed', {
            lastError: 'max resume attempts exceeded', verifyRetries: 0,
            resumeEpisodeAt: null,
          }, { expect: ['stopped'] });
          if (!applied) continue;
          log(`${s.key}: giving up after ${s.attempts} attempts`);
          notify('unsnooze gave up ⚠️', `${s.cwd}: ${s.attempts} resume attempts failed — check \`unsnooze status\``, { context: ctxOf(s), priority: 4 });
        }
      }

      const dispatched = [];
      for (const rec of due) {
        const result = await dispatchOne(rec, { mux: resolveMux(rec), resolveMux });
        const routed = routeDispatchOutcome(result, rec, deferCounts);
        if (routed.waitBusy) await sleep(BUSY_DEFER_MS);
        if (routed.verify) dispatched.push(rec.key);
        if (!routed.verify) continue;
        if (due.indexOf(rec) < due.length - 1) await sleep(STAGGER_MS);
      }

      const verifying = [...new Set([...resuming.map(rec => rec.key), ...dispatched])];
      if (verifying.length > 0) {
        await sleep(VERIFY_DELAY_MS);
        for (const key of verifying) await verifyOne(key, { resolveMux });
      }

      // Prompt queue delivery — strictly AFTER session dispatch/verify above,
      // and in its own try/catch, so a queue bug can never skip or delay a
      // session resume. Lazy dynamic import: prompt-queue.js statically
      // imports awaitReadyAndSend/retryBackoffMs from this module, so a
      // static import here would cycle. `queueMux` lets callers (tests) pin
      // a fake multiplexer for the queue path; the default lets
      // tickPromptQueue resolve its own (only touched when work exists).
      try {
        const { tickPromptQueue } = await import('./prompt-queue.js');
        await tickPromptQueue(queueMux ? { mux: queueMux } : {});
      } catch (err) {
        log(`prompt queue tick failed: ${err.message}`);
      }

      await sleep(pollInterval);
    }
  } finally {
    releaseSingleton();
    updateState(state => { if (state.resumerPid === process.pid) state.resumerPid = null; });
  }
}
