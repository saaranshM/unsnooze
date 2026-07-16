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
import { approxTokens } from './sessions.js';
import { latestRateLimitFromTranscript } from './watchers/claude.js';
import { getConfig, resolveResumeMessage } from './settings.js';
import { workspaceFingerprint, workspaceChanged, describeChange } from './workspace.js';
import { notify } from './notify.js';
import { UNSNOOZE_BIN } from './spawn.js';
import { makeLogger } from './logger.js';
import { createLeaseId, leaseMatches } from './lease.js';
import { autoReapIfEnabled, attachHint } from './reap.js';

const log = makeLogger('resumer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_VERIFY_RETRIES = 3;
const ctxOf = rec => ({ mux: rec.mux, pane: rec.pane, paneOwner: rec.paneOwner });

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

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
  // zellij needs UNSNOOZE_PANE_OWNER so bind() can address the right session.
  if (rec.mux === 'zellij') {
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
  const fromTx = latestRateLimitFromTranscript(rec.cwd, rec.sessionId, { now });
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
      setStatus(key, 'stopped', {
        resetAt: at, resetSource: source, bannerAt,
        lastError: 'limit still active (probe upgraded estimate)',
        probeCount: 0,
      });
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
    setStatus(key, 'stopped', {
      resetAt: now,
      resetSource: 'fallback',
      lastError: 'probe ceiling reached — attempting resume',
      probeCount: probeCount + 1,
    });
    log(`${key}: probe ceiling reached — attempting resume`);
    return null;   // proceed with dispatch
  }
  const delay = nextProbeDelayMs(probeCount, {
    intervalMs: PROBE_INTERVAL_MS, maxMs: PROBE_MAX_MS,
  });
  let nextAt = now + delay + RESET_MARGIN_MS;
  if (nextAt > ceiling) nextAt = ceiling;
  setStatus(key, 'stopped', {
    resetAt: nextAt,
    resetSource: 'fallback',
    lastError: 'limit still active — probing',
    probeCount: probeCount + 1,
  });
  log(`${key}: probe #${probeCount + 1} rescheduled to ${new Date(nextAt).toISOString()}`);
  return 'probe';
}

// Ordered safety decision. Returns: busy | retry | progress | held | injected | reopen | probe.
export async function dispatchOne(rec, {
  mux = resolveRecordMux(rec), resolveMux = null,
  resumeMessage, selfCmd = selfCommand(), fingerprint = workspaceFingerprint,
  notifier = notify, matchesLease = leaseMatches, contextTokens = null,
} = {}) {
  resolveMux ||= () => mux;
  const key = rec.key;
  const agent = getAgent(rec.agent);
  // Wake-message precedence: per-session (`unsnooze message <id> "..."`) →
  // explicit option → per-agent (`resumeMessages.<id>`) → global. Applies to
  // both the live-pane sendText and the argv reopen path.
  resumeMessage = rec.resumeMessage ?? resumeMessage ?? resolveResumeMessage(agent.id);

  // §4: fallback records probe cheaply before a real resume attempt.
  if (rec.resetSource === 'fallback' && !rec.manual) {
    const probed = await probeFallback(rec, { mux });
    if (probed === 'probe') return 'probe';
    // null → banner gone or ceiling hit — fall through to normal dispatch.
    // Re-read record in case probeFallback mutated it.
    rec = readState().sessions[key] || rec;
  }

  // Stale-workspace guard: another session (or a human) may have moved the
  // repo while this one slept. Manual resumes (resume-now) always proceed.
  const guardMode = getConfig('workspaceGuard');
  if (rec.workspace && guardMode !== 'off' && !rec.manual) {
    const change = workspaceChanged(rec, fingerprint(rec.cwd));
    if (change) {
      const desc = describeChange(change);
      if (guardMode === 'pause') {
        setStatus(key, 'stopped', { workspaceHold: true, holdReason: `workspace changed (${desc})` });
        notifier('unsnooze: session held', `${rec.cwd}: workspace changed while stopped (${desc}) — run: unsnooze resume-now`, { context: ctxOf(rec) });
        log(`${key}: workspace changed (${desc}) — held (workspaceGuard=pause)`);
        return 'held';
      }
      resumeMessage += `\n\nHeads up: this workspace changed while the session was stopped (${desc}). Re-read the current state of the repo before continuing.`;
      log(`${key}: workspace changed (${desc}) — informing agent in the wake message`);
    }
  }

  // Context-size guard: the prompt cache expired hours ago, so the first wake
  // message re-reads the session's entire context at full (uncached) price.
  // Estimate the size from the agent's transcript; `pause` holds big sessions,
  // `inform` notifies the user — but only once the wake actually lands, since
  // dispatchOne re-runs on every busy/retry tick. Manual resumes proceed.
  let contextNote = null;
  const ctxGuardMode = getConfig('contextGuard');
  if (ctxGuardMode !== 'off' && !rec.manual) {
    const estimate = contextTokens
      ?? (typeof agent.contextTokens === 'function' ? r => agent.contextTokens(r) : null);
    let tokens = null;
    try { tokens = estimate ? estimate(rec) : null; } catch { /* unknown size — skip */ }
    if (tokens != null && tokens >= getConfig('contextGuardTokens')) {
      const size = approxTokens(tokens);
      if (ctxGuardMode === 'pause') {
        setStatus(key, 'stopped', { workspaceHold: true, holdReason: `context ${size} tokens` });
        notifier('unsnooze: session held', `${rec.cwd}: waking would re-read ${size} tokens of context at full (uncached) price — run: unsnooze resume-now`, { context: ctxOf(rec) });
        log(`${key}: context ${size} tokens ≥ threshold — held (contextGuard=pause)`);
        return 'held';
      }
      contextNote = `${rec.cwd}: waking a ${size}-token session — its full context is re-read at full (uncached) price`;
      log(`${key}: context ${size} tokens — informing (contextGuard=inform)`);
    }
  }
  const notifyContext = () => {
    if (contextNote) notifier('unsnooze: big-context wake', contextNote, { context: ctxOf(rec) });
  };
  const reopenGuarded = () =>
    reopen(rec, { mux, resolveMux, agent, resumeMessage, selfCmd, onDelivered: notifyContext });

  // Live-pane path: only if the pane still exists AND the agent CLI is its
  // foreground command (pane ids get recycled — never inject into a random
  // program).
  if (rec.pane && await mux.paneAlive(rec.pane)) {
    let text;
    try { text = await mux.capturePane(rec.pane, CAPTURE_LINES); }
    catch (err) {
      setStatus(key, 'stopped', { lastError: `capture: ${err.message}` });
      return 'retry';
    }
    if (isBusy(text, agent.patterns.busyPatterns)) return 'busy';
    const d = detectLimit(text, PANE_SCAN_LINES, agent.patterns);
    const menu = !!(agent.menu && agent.menu.isPrompt(text, PANE_SCAN_LINES));
    let cmd = null;
    try { cmd = await mux.paneCurrentCommand(rec.pane); }
    catch (err) { log(`${key}: pane command lookup failed: ${err.message}`); }
    const contentOwned = menu || d.hit || agent.patterns.idleRegex.test(text);
    const leased = await matchesLease(rec, { mux });
    const owned = leased || agent.isForegroundCommand(cmd);
    const authorized = owned && contentOwned;

    if (menu) {
      if (!authorized) return reopenGuarded();
      if (!getConfig('menuAutoAnswer')) return 'held';
      try {
        if (await driveMenu(mux, rec.pane, agent, text)) return 'progress';
        setStatus(key, 'stopped', { lastError: 'menu drive: wait option unavailable' });
      } catch (err) {
        setStatus(key, 'stopped', { lastError: `menu drive: ${err.message}` });
      }
      return 'retry';
    }
    if (authorized) {
      setStatus(key, 'resuming', { lastAttemptAt: Date.now(), lastError: null, verifyRetries: 0 });
      await mux.sendText(rec.pane, resumeMessage);
      log(`${key}: sent continue via ${rec.mux} ${rec.paneOwner ?? '-'}:${rec.pane}`);
      notifyContext();
      return 'injected';
    }
    if (owned) return 'busy';
  }

  return reopenGuarded();
}

// onDelivered fires only when the resume message actually reached the agent
// (argv or typed) — not on ready-timeouts or a still-active limit banner.
async function reopen(rec, { mux, resolveMux, agent, resumeMessage, selfCmd, onDelivered = () => {} }) {
  const key = rec.key;
  const resume = agent.resumeArgs(rec.sessionId, resumeMessage);
  const leaseId = createLeaseId();
  const target = await reviveTarget(mux, rec);
  const launchSpec = {
    file: selfCmd[0], args: [...selfCmd.slice(1), '_run', agent.id, ...resume.args],
    env: reopenEnv(rec, leaseId, target),
  };
  setStatus(key, 'resuming', { lastAttemptAt: Date.now(), verifyRetries: 0 });
  let address;
  try {
    address = await mux.newWindow(target, rec.cwd || homedir(), launchSpec);
  } catch (err) {
    setStatus(key, 'stopped', {
      attempts: (rec.attempts || 0) + 1,
      lastError: `new-window: ${err.message}`,
      verifyRetries: 0,
    });
    return 'retry';
  }
  // Persist the revival target as muxSession so future joins and attach hints
  // name the session the pane actually lives in.
  updateState(state => {
    const s = state.sessions[key];
    if (s) Object.assign(s, address, { leaseId, muxSession: target });
  });
  const rebound = { ...rec, ...address, leaseId, muxSession: target };
  mux = resolveMux(rebound);
  log(`${key}: re-opened via ${rec.mux} ${address.paneOwner ?? '-'}:${address.pane} in session ${target}`);

  // The resume prompt traveled in argv (e.g. `codex resume <id> "msg"`) —
  // nothing to type into the TUI; verifyOne checks the outcome later.
  if (!resume.messageViaPane) { onDelivered(); return 'reopen'; }

  // Wait for the TUI to be ready (input prompt visible), then send the message.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    let text;
    try { text = await mux.capturePane(address.pane, CAPTURE_LINES); }
    catch { continue; }
    if ((agent.menu && agent.menu.isPrompt(text, PANE_SCAN_LINES)) || detectLimit(text, PANE_SCAN_LINES, agent.patterns).hit) {
      // Limit hadn't actually reset — the fresh session hit it immediately.
      return 'reopen';
    }
    // The idle input box: a prompt glyph with no busy footer.
    if (!isBusy(text, agent.patterns.busyPatterns) && agent.patterns.idleRegex.test(text)) {
      await mux.sendText(address.pane, resumeMessage);
      log(`${key}: resume message sent to new pane ${address.pane}`);
      onDelivered();
      return 'reopen';
    }
  }
  setStatus(key, 'stopped', {
    attempts: (rec.attempts || 0) + 1,
    lastError: 'ready timeout',
    verifyRetries: 0,
  });
  return 'retry';
}

function recordVerifyRetry(rec, lastError) {
  const verifyRetries = (rec.verifyRetries || 0) + 1;
  if (verifyRetries >= MAX_VERIFY_RETRIES) {
    const attempts = (rec.attempts || 0) + 1;
    setStatus(rec.key, 'stopped', {
      attempts,
      // Same backoff (and same manual exemption) as routed retries.
      resetAt: rec.manual ? Date.now() : Date.now() + retryBackoffMs(attempts),
      lastError,
      verifyRetries: 0,
    });
  } else {
    setStatus(rec.key, 'resuming', { lastError, verifyRetries });
  }
  return 'retry';
}

// Post-dispatch verification: did the limit banner come back?
export async function verifyOne(key, { resolveMux = resolveRecordMux } = {}) {
  const rec = readState().sessions[key];
  if (!rec || rec.status !== 'resuming') return;
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
    const fromTx = latestRateLimitFromTranscript(rec.cwd, rec.sessionId);
    if (fromTx) {
      resetLine = fromTx.resetLine ?? resetLine;
      bannerAt = fromTx.timestampMs;
    }
    const { at, source } = resetAtMs(parseResetTime(resetLine), {
      marginMs: RESET_MARGIN_MS,
      fallbackMs: PROBE_INTERVAL_MS,
      bannerAt,
    });
    setStatus(key, 'stopped', {
      attempts: (rec.attempts || 0) + 1, resetAt: at, resetSource: source,
      bannerAt: bannerAt ?? rec.bannerAt ?? null,
      lastError: 'limit still active at resume time', verifyRetries: 0,
      ...(source === 'fallback' ? { probeCount: (rec.probeCount || 0) + 1 } : { probeCount: 0 }),
    });
    log(`${key}: limit still active, rescheduled to ${new Date(at).toISOString()} (${source})`);
    return;
  }
  setStatus(key, 'resumed', { lastError: null, verifyRetries: 0 });
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
      setStatus(rec.key, 'resumed', { lastError: null, verifyRetries: 0 });
      return { verify: false, waitBusy: false };
    }
    return { verify: false, waitBusy: true };
  }
  if (result === 'retry') {
    const attempts = (rec.attempts || 0) + 1;
    setStatus(rec.key, 'stopped', {
      attempts,
      // Back off before the next attempt — a due record retried on every poll
      // tick exhausts MAX_RESUME_ATTEMPTS in minutes. Manual records are
      // exempt: `resume-now` promised an immediate wake, so a transient error
      // must not silently defer it.
      resetAt: rec.manual ? now : now + retryBackoffMs(attempts),
      lastError: readState().sessions[rec.key]?.lastError,
      verifyRetries: 0,
    });
    return { verify: false, waitBusy: false };
  }
  if (result === 'progress') {
    setStatus(rec.key, 'stopped', { lastError: null, verifyRetries: 0 });
    return { verify: false, waitBusy: false };
  }
  if (result === 'held' || result === 'probe') return { verify: false, waitBusy: false };
  return { verify: result === 'injected' || result === 'reopen', waitBusy: false };
}

// persistent: never exit on an empty ledger (daemon mode — `unsnooze daemon`,
// launchd/systemd). watcher: transcript watcher ticked every loop, so GUI
// sessions are detected without a hook or pane. signal: clean shutdown.
export async function runResumer({
  resolveMux = resolveRecordMux, pollInterval = POLL_INTERVAL_MS,
  persistent = false, watcher = null, signal = null,
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
  log(`resumer started (pid ${process.pid}${persistent ? ', persistent' : ''})`);
  const deferCounts = new Map();

  try {
    for (;;) {
      if (signal?.aborted) { log('shutdown requested — resumer exiting'); return 0; }
      await tickWatcher();

      // Scheduled cleanup: age prune + pane-aware sweep + abandon stale stops.
      try {
        updateState(state => { prune(state); return state; });
        await sweepRecords({ resolveMux });
        await markStaleAbandoned({ resolveMux });
        await autoReapIfEnabled({ resolveMux });
      } catch (err) {
        log(`cleanup tick failed: ${err.message}`);
      }

      const stopped = activeStopped();
      const resuming = Object.values(readState().sessions).filter(s => s.status === 'resuming');
      if (stopped.length === 0 && resuming.length === 0 && !persistent) {
        log('no pending sessions — resumer exiting');
        return 0;
      }

      const due = dueForDispatch().filter(s => (s.attempts || 0) < MAX_RESUME_ATTEMPTS);
      // Anything over the attempts cap is dead — mark failed so we can exit.
      for (const s of dueForDispatch()) {
        if ((s.attempts || 0) >= MAX_RESUME_ATTEMPTS) {
          setStatus(s.key, 'failed', { lastError: 'max resume attempts exceeded', verifyRetries: 0 });
          log(`${s.key}: giving up after ${s.attempts} attempts`);
          notify('unsnooze gave up ⚠️', `${s.cwd}: ${s.attempts} resume attempts failed — check \`unsnooze status\``, { context: ctxOf(s) });
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

      await sleep(pollInterval);
    }
  } finally {
    releaseSingleton();
    updateState(state => { if (state.resumerPid === process.pid) state.resumerPid = null; });
  }
}
