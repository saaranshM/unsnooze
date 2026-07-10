// Resumer daemon (`unsnooze _resumer`) — SINGLETON. Watches state.json for stopped
// sessions, polls wall-clock against the earliest resetAt (interval polling,
// never one long setTimeout — survives laptop sleep; a wake past the target
// fires on the next tick), then re-opens/continues every due session.
// Exits when no non-terminal records remain; the next limit event respawns it.

import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import * as realTmux from './tmux.js';
import {
  RESUMER_LOCK, STATE_DIR, POLL_INTERVAL_MS, STAGGER_MS, VERIFY_DELAY_MS,
  BUSY_DEFER_MS, MAX_BUSY_DEFERS, MAX_RESUME_ATTEMPTS, READY_TIMEOUT_MS,
  CAPTURE_LINES, PANE_SCAN_LINES, TMUX_SESSION_NAME,
  RESET_MARGIN_MS, FALLBACK_RESET_MS,
} from './config.js';
import { detectLimit, isBusy } from './patterns.js';
import { getAgent } from './agents/index.js';
import { parseResetTime, resetAtMs } from './time-parser.js';
import { readState, updateState, setStatus, dueSessions, activeStopped } from './state.js';
import { getConfig, resolveResumeMessage } from './settings.js';
import { notify } from './notify.js';
import { UNSNOOZE_BIN } from './spawn.js';
import { makeLogger } from './logger.js';

const log = makeLogger('resumer');
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  return dueSessions(now).filter(s => auto || s.manual);
}

function shellQuote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

// The reopen command runs inside a fresh tmux window, i.e. with the tmux
// SERVER's environment — which may lack npm globals or nvm's node on PATH.
// Always embed absolute paths. UNSNOOZE_SELF is the test-harness override.
function selfCommand() {
  return process.env.UNSNOOZE_SELF
    ? [process.env.UNSNOOZE_SELF]
    : [process.execPath, UNSNOOZE_BIN];
}

// Decide how to act on one due record. Pure-ish; tmux injectable.
// Returns: 'sent' | 'reopened' | 'deferred' | 'skip' | 'failed'
export async function dispatchOne(rec, { tmux = realTmux, resumeMessage, selfCmd = selfCommand() } = {}) {
  const key = rec.key;
  const agent = getAgent(rec.agent);
  // Explicit option wins; otherwise the agent's own message (or the global).
  resumeMessage = resumeMessage ?? resolveResumeMessage(agent.id);

  // Live-pane path: only if the pane still exists AND the agent CLI is its
  // foreground command (pane ids get recycled — never inject into a random
  // program).
  if (rec.pane && await tmux.paneAlive(rec.pane)) {
    const cmd = await tmux.paneCurrentCommand(rec.pane);
    if (agent.isForegroundCommand(cmd)) {
      const text = await tmux.capturePane(rec.pane, CAPTURE_LINES).catch(() => '');
      if (isBusy(text, agent.patterns.busyPatterns)) return 'deferred';
      setStatus(key, 'resuming', { lastAttemptAt: Date.now() });
      await tmux.sendText(rec.pane, resumeMessage);
      log(`${key}: sent continue to live pane ${rec.pane}`);
      return 'sent';
    }
    // Pane alive but the agent gone (user's shell now) — fall through to
    // re-open; never hijack a shell prompt with a chat message.
  }

  // Re-open path: new tmux window in the well-known session, resume by id.
  const resume = agent.resumeArgs(rec.sessionId, resumeMessage);
  const command = [...selfCmd, '_run', agent.id, ...resume.args].map(shellQuote).join(' ');
  setStatus(key, 'resuming', { lastAttemptAt: Date.now() });
  let newPane;
  try {
    newPane = await tmux.newWindow(rec.tmuxSession || TMUX_SESSION_NAME, rec.cwd, command);
  } catch (err) {
    setStatus(key, 'stopped', { attempts: (rec.attempts || 0) + 1, lastError: `new-window: ${err.message}` });
    return 'failed';
  }
  updateState(state => {
    const s = state.sessions[key];
    if (s) s.pane = newPane;
  });
  log(`${key}: re-opened in pane ${newPane} (${command})`);

  // The resume prompt traveled in argv (e.g. `codex resume <id> "msg"`) —
  // nothing to type into the TUI; verifyOne checks the outcome later.
  if (!resume.messageViaPane) return 'reopened';

  // Wait for the TUI to be ready (input prompt visible), then send the message.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    const text = await tmux.capturePane(newPane, CAPTURE_LINES).catch(() => '');
    if ((agent.menu && agent.menu.isPrompt(text, PANE_SCAN_LINES)) || detectLimit(text, PANE_SCAN_LINES, agent.patterns).hit) {
      // Limit hadn't actually reset — the fresh session hit it immediately.
      return 'failed';
    }
    // The idle input box: a prompt glyph with no busy footer.
    if (!isBusy(text, agent.patterns.busyPatterns) && agent.patterns.idleRegex.test(text)) {
      await tmux.sendText(newPane, resumeMessage);
      log(`${key}: resume message sent to new pane ${newPane}`);
      return 'reopened';
    }
  }
  setStatus(key, 'stopped', { attempts: (rec.attempts || 0) + 1, lastError: 'ready timeout' });
  return 'failed';
}

// Post-dispatch verification: did the limit banner come back?
export async function verifyOne(key, { tmux = realTmux } = {}) {
  const rec = readState().sessions[key];
  if (!rec || rec.status !== 'resuming') return;
  const agent = getAgent(rec.agent);
  const text = rec.pane ? await tmux.capturePane(rec.pane, CAPTURE_LINES).catch(() => '') : '';
  const d = detectLimit(text, PANE_SCAN_LINES, agent.patterns);
  if (d.hit || (agent.menu && agent.menu.isPrompt(text, PANE_SCAN_LINES))) {
    // Limit not actually reset — reschedule from the fresh banner.
    const { at, source } = resetAtMs(parseResetTime(d.resetLine), {
      marginMs: RESET_MARGIN_MS, fallbackMs: FALLBACK_RESET_MS,
    });
    setStatus(key, 'stopped', {
      attempts: (rec.attempts || 0) + 1, resetAt: at, resetSource: source,
      lastError: 'limit still active at resume time',
    });
    log(`${key}: limit still active, rescheduled to ${new Date(at).toISOString()}`);
    return;
  }
  setStatus(key, 'resumed');
  log(`${key}: verified resumed`);
  notify('unsnoozed ✅', `${rec.cwd} is running again`);
}

export async function runResumer({ tmux = realTmux, pollInterval = POLL_INTERVAL_MS } = {}) {
  if (!acquireSingleton()) { log('another resumer is running — exiting'); return 0; }
  updateState(state => { state.resumerPid = process.pid; });
  log(`resumer started (pid ${process.pid})`);
  const deferCounts = new Map();

  try {
    for (;;) {
      const stopped = activeStopped();
      const resuming = Object.values(readState().sessions).filter(s => s.status === 'resuming');
      if (stopped.length === 0 && resuming.length === 0) {
        log('no pending sessions — resumer exiting');
        return 0;
      }

      const due = dueForDispatch().filter(s => (s.attempts || 0) < MAX_RESUME_ATTEMPTS);
      // Anything over the attempts cap is dead — mark failed so we can exit.
      for (const s of dueForDispatch()) {
        if ((s.attempts || 0) >= MAX_RESUME_ATTEMPTS) {
          setStatus(s.key, 'failed', { lastError: 'max resume attempts exceeded' });
          log(`${s.key}: giving up after ${s.attempts} attempts`);
          notify('unsnooze gave up ⚠️', `${s.cwd}: ${s.attempts} resume attempts failed — check \`unsnooze status\``);
        }
      }

      const dispatched = [];
      for (const rec of due) {
        const result = await dispatchOne(rec, { tmux });
        if (result === 'deferred') {
          const n = (deferCounts.get(rec.key) || 0) + 1;
          deferCounts.set(rec.key, n);
          if (n > MAX_BUSY_DEFERS) {
            setStatus(rec.key, 'resumed', { lastError: null });
            log(`${rec.key}: busy through ${n} defers — it is clearly working, marking resumed`);
          } else {
            await sleep(BUSY_DEFER_MS);
          }
          continue;
        }
        if (result === 'sent' || result === 'reopened') dispatched.push(rec.key);
        if (due.indexOf(rec) < due.length - 1) await sleep(STAGGER_MS);
      }

      if (dispatched.length > 0) {
        await sleep(VERIFY_DELAY_MS);
        for (const key of dispatched) await verifyOne(key, { tmux });
      }

      await sleep(pollInterval);
    }
  } finally {
    releaseSingleton();
    updateState(state => { if (state.resumerPid === process.pid) state.resumerPid = null; });
  }
}
