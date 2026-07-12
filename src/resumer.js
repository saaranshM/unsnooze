// Resumer daemon (`unsnooze _resumer`) — SINGLETON. Watches state.json for stopped
// sessions, polls wall-clock against the earliest resetAt (interval polling,
// never one long setTimeout — survives laptop sleep; a wake past the target
// fires on the next tick), then re-opens/continues every due session.
// Exits when no non-terminal records remain; the next limit event respawns it.

import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { getMultiplexer } from './multiplexer.js';
import {
  RESUMER_LOCK, STATE_DIR, POLL_INTERVAL_MS, STAGGER_MS, VERIFY_DELAY_MS,
  BUSY_DEFER_MS, MAX_BUSY_DEFERS, MAX_RESUME_ATTEMPTS, READY_TIMEOUT_MS,
  CAPTURE_LINES, PANE_SCAN_LINES, MUX_SESSION_NAME,
  RESET_MARGIN_MS, FALLBACK_RESET_MS,
} from './config.js';
import { detectLimit, isBusy } from './patterns.js';
import { getAgent } from './agents/index.js';
import { parseResetTime, resetAtMs } from './time-parser.js';
import { readState, updateState, setStatus, dueSessions, activeStopped } from './state.js';
import { getConfig, resolveResumeMessage } from './settings.js';
import { workspaceFingerprint, workspaceChanged, describeChange } from './workspace.js';
import { notify } from './notify.js';
import { UNSNOOZE_BIN } from './spawn.js';
import { makeLogger } from './logger.js';
import { createLeaseId, leaseMatches } from './lease.js';

const log = makeLogger('resumer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_VERIFY_RETRIES = 3;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function acquireSingleton() {
  mkdirSync(STATE_DIR, { recursive: true });
  try {
    const pid = parseInt(readFileSync(RESUMER_LOCK, 'utf-8'), 10);
    if (Number.isFinite(pid) && pid !== process.pid && pidAlive(pid)) return false;
  } catch { /* no lock */ }
  writeFileSync(RESUMER_LOCK, String(process.pid));
  return true;
}

export function releaseSingleton() {
  try {
    const pid = parseInt(readFileSync(RESUMER_LOCK, 'utf-8'), 10);
    if (pid === process.pid) unlinkSync(RESUMER_LOCK);
  } catch { /* already gone */ }
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

function reopenEnv(rec, leaseId) {
  const env = { ...(rec.env || {}) };
  env.UNSNOOZE_MUX = rec.mux;
  if (rec.muxSession) env.UNSNOOZE_PANE_OWNER = rec.muxSession;
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

// Ordered safety decision. Returns: busy | retry | progress | held | injected | reopen.
export async function dispatchOne(rec, {
  mux = resolveRecordMux(rec), resolveMux = null,
  resumeMessage, selfCmd = selfCommand(), fingerprint = workspaceFingerprint,
  notifier = notify, matchesLease = leaseMatches,
} = {}) {
  resolveMux ||= () => mux;
  const key = rec.key;
  const agent = getAgent(rec.agent);
  // Wake-message precedence: per-session (`unsnooze message <id> "..."`) →
  // explicit option → per-agent (`resumeMessages.<id>`) → global. Applies to
  // both the live-pane sendText and the argv reopen path.
  resumeMessage = rec.resumeMessage ?? resumeMessage ?? resolveResumeMessage(agent.id);

  // Stale-workspace guard: another session (or a human) may have moved the
  // repo while this one slept. Manual resumes (resume-now) always proceed.
  const guardMode = getConfig('workspaceGuard');
  if (rec.workspace && guardMode !== 'off' && !rec.manual) {
    const change = workspaceChanged(rec, fingerprint(rec.cwd));
    if (change) {
      const desc = describeChange(change);
      if (guardMode === 'pause') {
        setStatus(key, 'stopped', { workspaceHold: true, holdReason: desc });
        notifier('unsnooze: session held', `${rec.cwd}: workspace changed while stopped (${desc}) — run: unsnooze resume-now`);
        log(`${key}: workspace changed (${desc}) — held (workspaceGuard=pause)`);
        return 'held';
      }
      resumeMessage += `\n\nHeads up: this workspace changed while the session was stopped (${desc}). Re-read the current state of the repo before continuing.`;
      log(`${key}: workspace changed (${desc}) — informing agent in the wake message`);
    }
  }

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
      if (!authorized) return reopen(rec, { mux, resolveMux, agent, resumeMessage, selfCmd });
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
      return 'injected';
    }
    if (owned) return 'busy';
  }

  return reopen(rec, { mux, resolveMux, agent, resumeMessage, selfCmd });
}

async function reopen(rec, { mux, resolveMux, agent, resumeMessage, selfCmd }) {
  const key = rec.key;
  const resume = agent.resumeArgs(rec.sessionId, resumeMessage);
  const leaseId = createLeaseId();
  const launchSpec = {
    file: selfCmd[0], args: [...selfCmd.slice(1), '_run', agent.id, ...resume.args],
    env: reopenEnv(rec, leaseId),
  };
  setStatus(key, 'resuming', { lastAttemptAt: Date.now(), verifyRetries: 0 });
  let address;
  try {
    address = await mux.newWindow(rec.muxSession ?? rec.tmuxSession ?? MUX_SESSION_NAME,
      rec.cwd || homedir(), launchSpec);
  } catch (err) {
    setStatus(key, 'stopped', {
      attempts: (rec.attempts || 0) + 1,
      lastError: `new-window: ${err.message}`,
      verifyRetries: 0,
    });
    return 'retry';
  }
  updateState(state => {
    const s = state.sessions[key];
    if (s) Object.assign(s, address, { leaseId });
  });
  const rebound = { ...rec, ...address, leaseId };
  mux = resolveMux(rebound);
  log(`${key}: re-opened via ${rec.mux} ${address.paneOwner ?? '-'}:${address.pane}`);

  // The resume prompt traveled in argv (e.g. `codex resume <id> "msg"`) —
  // nothing to type into the TUI; verifyOne checks the outcome later.
  if (!resume.messageViaPane) return 'reopen';

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
    setStatus(rec.key, 'stopped', {
      attempts: (rec.attempts || 0) + 1,
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
    const { at, source } = resetAtMs(parseResetTime(d.resetLine), {
      marginMs: RESET_MARGIN_MS, fallbackMs: FALLBACK_RESET_MS,
    });
    setStatus(key, 'stopped', {
      attempts: (rec.attempts || 0) + 1, resetAt: at, resetSource: source,
      lastError: 'limit still active at resume time', verifyRetries: 0,
    });
    log(`${key}: limit still active, rescheduled to ${new Date(at).toISOString()}`);
    return;
  }
  setStatus(key, 'resumed', { lastError: null, verifyRetries: 0 });
  log(`${key}: verified resumed`);
  const fromGui = rec.origin && rec.origin !== 'cli';
  notify('unsnoozed ✅', `${rec.cwd} is running again${fromGui ? ` (was in ${rec.origin} — revived in ${rec.mux})` : ''}`);
  return 'resumed';
}

export function routeDispatchOutcome(result, rec, deferCounts, { maxBusyDefers = MAX_BUSY_DEFERS } = {}) {
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
    setStatus(rec.key, 'stopped', {
      attempts: (rec.attempts || 0) + 1,
      lastError: readState().sessions[rec.key]?.lastError,
      verifyRetries: 0,
    });
    return { verify: false, waitBusy: false };
  }
  if (result === 'progress') {
    setStatus(rec.key, 'stopped', { lastError: null, verifyRetries: 0 });
    return { verify: false, waitBusy: false };
  }
  if (result === 'held') return { verify: false, waitBusy: false };
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
  while (!acquireSingleton()) {
    if (!persistent) { log('another resumer is running — exiting'); return 0; }
    if (signal?.aborted) return 0;
    await tickWatcher();
    log('another resumer holds the lock — daemon waiting');
    await sleep(pollInterval);
  }
  updateState(state => { state.resumerPid = process.pid; });
  log(`resumer started (pid ${process.pid}${persistent ? ', persistent' : ''})`);
  const deferCounts = new Map();

  try {
    for (;;) {
      if (signal?.aborted) { log('shutdown requested — resumer exiting'); return 0; }
      await tickWatcher();
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
          notify('unsnooze gave up ⚠️', `${s.cwd}: ${s.attempts} resume attempts failed — check \`unsnooze status\``);
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
