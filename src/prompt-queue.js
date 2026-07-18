// One-shot prompt queue: user-predefined prompts that, once a usage limit
// clears, spawn a NEW agent session in a project cwd and type the prompt in.
// This module owns state plumbing (CRUD, sanitization, due-ness) AND
// dispatch — spawning the fresh window, typing the prompt, verifying it
// landed. tickPromptQueue is called from the resumer's own loop (additive
// only — see resumer.js) but this module never imports the resumer
// statically, to avoid a load cycle: resumer.js dynamic-imports us instead.

import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { updateState, readState, prune } from './state.js';
import { listAgents, getAgent } from './agents/index.js';
import { resolveClaudeResetAnchor, readUsageStore } from './usage.js';
import { spawnResumerIfNeeded, UNSNOOZE_BIN } from './spawn.js';
import { getMultiplexer } from './multiplexer.js';
import { createLeaseId } from './lease.js';
import { parseResetTime, resetAtMs } from './time-parser.js';
import { detectLimit } from './patterns.js';
import { notify } from './notify.js';
import { attachHint } from './reap.js';
import { makeLogger } from './logger.js';
import { awaitReadyAndSend, retryBackoffMs } from './resumer.js';
import {
  RESUME_SESSION_NAME, VERIFY_DELAY_MS, STAGGER_MS, CAPTURE_LINES,
  PANE_SCAN_LINES, RESET_MARGIN_MS, PROBE_INTERVAL_MS, MAX_RESUME_ATTEMPTS,
} from './config.js';

const log = makeLogger('prompt-queue');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CREATED_BY = ['local', 'remote'];
const MODES = ['next-reset', 'at', 'now'];
const QUEUE_CAP = 50;
const MAX_CWD_LEN = 1024;
const MAX_PROMPT_LEN = 4000;
const TERMINAL_STATUSES = ['delivered', 'failed', 'cancelled'];
const AGENT_IDS = new Set(listAgents().map(a => a.id));

// Strip full ANSI/VT escape sequences (CSI, OSC, DCS/other string types, bare
// two-char escapes) so a queued prompt can never inject cursor moves, title
// changes, or hyperlinks into whatever pane later types it out.
/* eslint-disable no-control-regex */
const ANSI_SEQ_RE =
  /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|\[[0-9:;<=>?]*[ -/]*[@-~]|[ -~])/g;
// Remaining C0/C1 control bytes and DEL, except \n (0x0a) and \t (0x09) which
// a multi-line prompt legitimately needs.
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

export function sanitizePrompt(text) {
  if (text == null) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(ANSI_SEQ_RE, '')
    .replace(CONTROL_RE, '')
    .trim()
    .slice(0, MAX_PROMPT_LEN);
}

// `queueAdd` never throws on validation — callers (CLI, remote ingest) render
// `error` directly to the user.
// `spawn`/`spawnFn` let callers (and tests) suppress or observe the
// wake-a-transient-resumer side effect without forking a real process —
// production callers (CLI, remote ingest) get it for free via the defaults.
export function queueAdd({
  cwd, agent, prompt, mode = 'next-reset', atMs = null, createdBy = 'local',
  spawn = true, spawnFn = spawnResumerIfNeeded,
} = {}) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > MAX_CWD_LEN) {
    return { ok: false, error: `cwd must be an absolute path of at most ${MAX_CWD_LEN} characters` };
  }
  if (!AGENT_IDS.has(agent)) {
    return { ok: false, error: `unknown agent: ${agent}` };
  }
  const sanitized = sanitizePrompt(prompt);
  if (!sanitized) {
    return { ok: false, error: 'prompt is empty after sanitization' };
  }
  if (!MODES.includes(mode)) {
    return { ok: false, error: `mode must be one of: ${MODES.join(', ')}` };
  }
  if (mode === 'at' && !Number.isFinite(atMs)) {
    return { ok: false, error: 'atMs must be a finite number when mode is "at"' };
  }
  if (!CREATED_BY.includes(createdBy)) {
    return { ok: false, error: `createdBy must be one of: ${CREATED_BY.join(', ')}` };
  }

  let result;
  updateState(state => {
    prune(state);
    const dup = state.promptQueue.find(e => e.status === 'pending'
      && e.cwd === cwd && e.agent === agent && e.prompt === sanitized);
    if (dup) {
      result = { ok: false, error: 'duplicate', existing: { ...dup } };
      return state;
    }
    const nonTerminal = state.promptQueue.filter(e => !TERMINAL_STATUSES.includes(e.status));
    if (nonTerminal.length >= QUEUE_CAP) {
      result = { ok: false, error: 'queue full' };
      return state;
    }
    const entry = {
      id: `p-${randomBytes(4).toString('hex')}`,
      cwd,
      agent,
      prompt: sanitized,
      mode,
      atMs: mode === 'at' ? atMs : null,
      notBefore: 0,
      createdAt: Date.now(),
      createdBy,
      status: 'pending',
      attempts: 0,
      lastError: null,
      deliveredAt: null,
      sentAt: null,
      pane: null,
      muxSession: null,
      leaseId: null,
    };
    state.promptQueue.push(entry);
    result = { ok: true, entry: { ...entry } };
    return state;
  });
  // Wake a transient resumer so a due entry (mode 'now'/'at') doesn't sit
  // until the next unrelated tick — mirrors markResumeNow's spawn-on-mutate.
  if (result.ok && spawn) spawnFn();
  return result;
}

export function queueList() {
  return [...readState().promptQueue]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(e => ({ ...e }));
}

// pending/launching → cancelled (terminal, later pruned). Already-terminal or
// unknown ids are a no-op — the caller should treat `false` as "nothing to do".
export function queueRemove(id) {
  let removed = false;
  updateState(state => {
    const entry = state.promptQueue.find(e => e.id === id);
    if (entry && ['pending', 'launching'].includes(entry.status)) {
      entry.status = 'cancelled';
      removed = true;
    }
    return state;
  });
  return removed;
}

export function queueClear() {
  let count = 0;
  updateState(state => {
    for (const entry of state.promptQueue) {
      if (['pending', 'launching'].includes(entry.status)) {
        entry.status = 'cancelled';
        count += 1;
      }
    }
    return state;
  });
  return count;
}

// Min future resetAt among an agent's stopped/resuming session records, with
// the same 60s margin peel resolveClaudeResetAnchor uses (usage.js:649) —
// `resetAt` in the ledger already includes RESET_MARGIN_MS.
function bestRecordAnchor(agentId, sessions, now) {
  const list = sessions ? Object.values(sessions) : Object.values(readState().sessions || {});
  let best = null;
  for (const s of list) {
    if (s.agent !== agentId) continue;
    if (!['stopped', 'resuming'].includes(s.status)) continue;
    if (!Number.isFinite(s.resetAt)) continue;
    const raw = s.resetAt - 60_000;
    if (raw <= now - 60_000) continue;
    if (best == null || raw < best) best = raw;
  }
  return best;
}

// Best-known reset-window anchor for an agent. Never fabricates a time: no
// signal → { resetAtMs: null, source: null }.
export function resolveAgentResetAnchor(agentId, { sessions = null, now = Date.now() } = {}) {
  if (agentId === 'claude') {
    const { resetAtMs, source } = resolveClaudeResetAnchor({ sessions, now });
    return { resetAtMs, source };
  }
  if (agentId === 'codex') {
    const samples = (readUsageStore().samples || [])
      .filter(s => s.agent === 'codex' && Number.isFinite(s.at));
    if (samples.length) {
      const latest = samples.reduce((a, b) => (b.at > a.at ? b : a));
      const resetsAtMs = latest.primary?.resetsAtMs;
      if (Number.isFinite(resetsAtMs) && resetsAtMs > now) {
        return { resetAtMs: resetsAtMs, source: 'usage-store' };
      }
    }
    const recordBest = bestRecordAnchor('codex', sessions, now);
    return recordBest == null ? { resetAtMs: null, source: null } : { resetAtMs: recordBest, source: 'record' };
  }
  const recordBest = bestRecordAnchor(agentId, sessions, now);
  return recordBest == null ? { resetAtMs: null, source: null } : { resetAtMs: recordBest, source: 'record' };
}

// Pending entries due now, FIFO. `anchors` (agentId -> {resetAtMs}) lets
// tests/callers inject reset knowledge; when omitted, resolved once per
// distinct agent among the pending 'next-reset' entries.
export function duePromptEntries(now = Date.now(), { anchors = null } = {}) {
  const pending = queueList().filter(e => e.status === 'pending');
  const resolved = anchors ? anchors : {};
  if (!anchors) {
    const agentIds = new Set(pending.filter(e => e.mode === 'next-reset').map(e => e.agent));
    for (const id of agentIds) resolved[id] = resolveAgentResetAnchor(id, { now });
  }
  return pending.filter(e => {
    // notBefore is a universal backoff floor — set by a failed dispatch
    // attempt (dispatchPromptEntry/verifyPromptEntry) regardless of mode, so
    // it must gate 'now'/'at' entries too, not just 'next-reset'. Without
    // this, a failing 'now' entry gets redispatched on literally the very
    // next tick and burns MAX_RESUME_ATTEMPTS in milliseconds.
    if (now < e.notBefore) return false;
    if (e.mode === 'now') return true;
    if (e.mode === 'at') return now >= e.atMs;
    // next-reset
    const resetAtMs = resolved[e.agent]?.resetAtMs ?? null;
    return resetAtMs === null || resetAtMs <= now;
  });
}

// --- delivery -----------------------------------------------------------
// Turns a due entry into a fresh agent session: open a window in the
// daemon's resume session, wait for the TUI to go idle, type the prompt
// once. Structurally mirrors resumer.js reopen()/verifyOne(), but there is
// no prior pane/session to revive — every dispatch is a brand-new window.

function selfCommand() {
  return process.env.UNSNOOZE_SELF
    ? [process.env.UNSNOOZE_SELF]
    : [process.execPath, UNSNOOZE_BIN];
}

function dispatchEnv(entry, leaseId, mux, target) {
  const env = { UNSNOOZE_MUX: mux.name, UNSNOOZE_LEASE_ID: leaseId, UNSNOOZE_CWD: entry.cwd };
  // tmux pane ids are server-global — paneOwner is always null there. Only
  // zellij needs UNSNOOZE_PANE_OWNER so bind() can address the right session
  // (same reasoning as resumer.js's reopenEnv).
  if (mux.name === 'zellij') env.UNSNOOZE_PANE_OWNER = target;
  return env;
}

// Notify context shape mirrors resumer.js's ctxOf(rec), but prompt-queue
// entries have no persisted mux-backend/paneOwner fields (every dispatch
// always targets RESUME_SESSION_NAME on whichever mux the caller resolved),
// so the live mux object supplies mux.name/mux.owner instead of a record.
function queueNotifyContext(mux, pane) {
  return { mux: mux?.name ?? null, pane, paneOwner: mux?.owner ?? null };
}

function updateEntry(id, patch) {
  let updated = null;
  updateState(state => {
    const e = state.promptQueue.find(x => x.id === id);
    if (e) {
      Object.assign(e, typeof patch === 'function' ? patch(e) : patch);
      updated = { ...e };
    }
    return state;
  });
  return updated;
}

// Shared "give up on this attempt, back off" landing spot for timeout /
// unparseable-limit / new-window-threw outcomes.
function retryPromptEntry(entry, { notBefore, lastError }) {
  return updateEntry(entry.id, e => ({
    status: 'pending',
    attempts: (e.attempts || 0) + 1,
    notBefore,
    lastError,
  }));
}

function failPromptEntry(entry, lastError, { mux = null, notifier = notify } = {}) {
  const updated = updateEntry(entry.id, { status: 'failed', lastError });
  if (updated) {
    notifier(
      'queued prompt failed ⚠️',
      `${updated.cwd}: ${updated.attempts} attempts failed — check \`unsnooze queue list\``,
      { context: queueNotifyContext(mux, updated.pane), priority: 4 },
    );
  }
  return updated;
}

// Parsed reset banner → notBefore = the parsed epoch; unparseable/no banner
// → notBefore = now + retryBackoffMs(attempts-after-this-one). Shared by the
// dispatch-time immediate-limit path and verifyPromptEntry's post-hoc check.
function limitNotBefore(resetLine, attemptsAfter, now) {
  if (resetLine) {
    const { at } = resetAtMs(parseResetTime(resetLine), {
      marginMs: RESET_MARGIN_MS, fallbackMs: PROBE_INTERVAL_MS, now: new Date(now),
    });
    return at;
  }
  return now + retryBackoffMs(attemptsAfter);
}

// dispatchPromptEntry: pending → launching (CAS) → open a fresh window →
// type the prompt once idle. Never throws for the outcomes it knows about
// (limit / timeout / new-window failure) — those all land back on `pending`
// with backoff. Only truly unexpected errors (bugs) propagate; tickPromptQueue
// wraps every call anyway so a queue bug can never escape into the resumer's
// own session-dispatch tick.
export async function dispatchPromptEntry(entry, {
  mux, now = Date.now(), notifier = notify, readyTimeoutMs = undefined,
} = {}) {
  if ((entry.attempts || 0) >= MAX_RESUME_ATTEMPTS) {
    return failPromptEntry(entry, `max resume attempts (${entry.attempts}) exceeded`, { mux, notifier });
  }

  // updateEntry returns the post-state regardless of who performed the
  // transition, so `cased.status === 'launching'` alone can't tell a winner
  // from a loser (a loser reading 'pending' as false applies {} and still
  // sees 'launching' from whoever did win). Capture the CAS outcome directly
  // in the mutator closure instead.
  let transitioned = false;
  const cased = updateEntry(entry.id, e => {
    if (e.status !== 'pending') return {};
    transitioned = true;
    return { status: 'launching' };
  });
  if (!cased || !transitioned) {
    // Someone else already moved it (or it's gone) — nothing to do.
    return readState().promptQueue.find(e => e.id === entry.id) || entry;
  }

  const agent = getAgent(cased.agent);
  const launch = agent.launchArgs(cased.prompt);
  const leaseId = createLeaseId();
  const target = RESUME_SESSION_NAME;
  const selfCmd = selfCommand();
  const launchSpec = {
    file: selfCmd[0],
    args: [...selfCmd.slice(1), '_run', agent.id, ...launch.args],
    env: dispatchEnv(cased, leaseId, mux, target),
  };

  let address;
  try {
    address = await mux.newWindow(target, cased.cwd, launchSpec);
  } catch (err) {
    log(`${cased.id}: new-window failed in session "${target}": ${err.message}`);
    return retryPromptEntry(cased, {
      notBefore: now + retryBackoffMs((cased.attempts || 0) + 1),
      lastError: `new-window: ${err.message}`,
    });
  }

  // Stamp the fresh pane as ours (best-effort; tmux only) — same as reopen().
  if (address?.pane && typeof mux.stampPaneOwner === 'function') {
    try { await mux.stampPaneOwner(address.pane, leaseId); } catch { /* legacy tmux */ }
  }
  updateEntry(cased.id, { pane: address?.pane ?? null, muxSession: target, leaseId });
  log(`${cased.id}: opened ${agent.id} in ${mux.name} ${address?.paneOwner ?? '-'}:${address?.pane} (session ${target})`);

  if (!launch.messageViaPane) {
    // Defensive only — every v1 adapter's launchArgs returns messageViaPane:
    // true, so this path is currently unreachable. If a future adapter sends
    // the prompt via argv instead, there's nothing left to type; treat it as
    // delivered-pending-verification, same as reopen()'s argv branch.
    return updateEntry(cased.id, { sentAt: now });
  }

  const outcome = await awaitReadyAndSend(mux, address.pane, agent, cased.prompt,
    readyTimeoutMs != null ? { timeoutMs: readyTimeoutMs } : undefined);
  if (outcome === 'sent') {
    log(`${cased.id}: prompt sent to new pane ${address.pane}`);
    return updateEntry(cased.id, { sentAt: now });
  }
  if (outcome === 'limit') {
    // The limit hadn't actually reset — the fresh session hit it immediately.
    // Note: unlike reopen(), we don't kill the just-opened window — resumer's
    // own reopen() leaves a still-limited fresh pane open too (verifyOne
    // reschedules from it later); there's no verify step here since we're
    // going straight back to pending, so the window is simply abandoned.
    let text = null;
    try { text = await mux.capturePane(address.pane, CAPTURE_LINES); } catch { /* window may already be gone */ }
    const d = text ? detectLimit(text, PANE_SCAN_LINES, agent.patterns) : { hit: false, resetLine: null };
    const attemptsAfter = (cased.attempts || 0) + 1;
    return retryPromptEntry(cased, {
      notBefore: limitNotBefore(d.hit ? d.resetLine : null, attemptsAfter, now),
      lastError: 'limit still active',
    });
  }
  // outcome === 'timeout'
  return retryPromptEntry(cased, {
    notBefore: now + retryBackoffMs((cased.attempts || 0) + 1),
    lastError: 'ready timeout',
  });
}

// verifyPromptEntry: for a `launching` entry whose prompt was sent
// VERIFY_DELAY_MS ago, confirm delivery. A still-active limit banner sends
// it back to pending (rescheduled from the fresh banner, like verifyOne). A
// clean pane — or a pane we can no longer read because the window already
// closed — counts as delivered: we cannot re-verify a closed window, and a
// one-shot prompt queue entry has no live pane to keep polling, so treat
// "can't tell anymore" as success rather than retrying forever.
export async function verifyPromptEntry(entry, { mux, now = Date.now(), notifier = notify } = {}) {
  if (entry.status !== 'launching' || !entry.sentAt) return entry;
  if (now - entry.sentAt < VERIFY_DELAY_MS) return entry;

  const agent = getAgent(entry.agent);
  let text = null;
  let readable = false;
  if (entry.pane) {
    try { text = await mux.capturePane(entry.pane, CAPTURE_LINES); readable = true; }
    catch { readable = false; }
  }

  if (readable) {
    const d = detectLimit(text, PANE_SCAN_LINES, agent.patterns);
    const menu = !!(agent.menu && agent.menu.isPrompt(text, PANE_SCAN_LINES));
    if (d.hit || menu) {
      const attemptsAfter = (entry.attempts || 0) + 1;
      return retryPromptEntry(entry, {
        notBefore: limitNotBefore(d.hit ? d.resetLine : null, attemptsAfter, now),
        lastError: 'limit still active at delivery time',
      });
    }
  }

  const updated = updateEntry(entry.id, { status: 'delivered', deliveredAt: now, lastError: null });
  if (updated) {
    const session = updated.muxSession || RESUME_SESSION_NAME;
    const hint = attachHint(mux?.name, session);
    const where = hint ? ` in ${session} — attach: ${hint}` : '';
    notifier(
      'queued prompt delivered ▶',
      `${updated.cwd}: new ${updated.agent} session started${where}`,
      { context: queueNotifyContext(mux, updated.pane) },
    );
    log(`${updated.id}: delivered${readable ? '' : ' (pane unreadable — unverified)'}`);
  }
  return updated;
}

// tickPromptQueue: called from the resumer's own loop each tick, after
// session dispatch (see resumer.js runResumer). Must never throw — every
// internal step is wrapped so a queue bug can never skip or delay a session
// resume, which is the one thing this feature must never touch.
export async function tickPromptQueue({ mux = null, now = Date.now(), notifier = notify } = {}) {
  try {
    const due = duePromptEntries(now);
    const launching = queueList().filter(e => e.status === 'launching');
    if (due.length === 0 && launching.length === 0) return;   // nothing to do — never touch a mux

    // Every dispatch targets the single RESUME_SESSION_NAME session, so one
    // mux resolution (bound to that session for zellij) covers dispatch AND
    // verify for the whole tick. Only resolved here (not eagerly) so an
    // empty/idle queue — the overwhelming common case — never probes for a
    // real multiplexer backend.
    const resolved = mux || getMultiplexer(undefined, { owner: RESUME_SESSION_NAME });

    for (let i = 0; i < due.length; i++) {
      try {
        await dispatchPromptEntry(due[i], { mux: resolved, now, notifier });
      } catch (err) {
        log(`dispatch ${due[i].id} failed: ${err.message}`);
      }
      if (i < due.length - 1) await sleep(STAGGER_MS);
    }

    // Re-read: dispatch above may have moved entries into 'launching' (freshly
    // sent) that are also eligible once VERIFY_DELAY_MS elapses on a later tick.
    for (const entry of queueList().filter(e => e.status === 'launching')) {
      try {
        await verifyPromptEntry(entry, { mux: resolved, now, notifier });
      } catch (err) {
        log(`verify ${entry.id} failed: ${err.message}`);
      }
    }
  } catch (err) {
    log(`tickPromptQueue failed: ${err.message}`);
  }
}
