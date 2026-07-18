// One-shot prompt queue: user-predefined prompts that, once a usage limit
// clears, spawn a NEW agent session in a project cwd and type the prompt in.
// This module owns state plumbing only — CRUD, sanitization, and due-ness.
// Dispatch (actually spawning + typing) lives in the resumer, not here.

import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { updateState, readState, prune } from './state.js';
import { listAgents } from './agents/index.js';
import { resolveClaudeResetAnchor, readUsageStore } from './usage.js';

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
export function queueAdd({
  cwd, agent, prompt, mode = 'next-reset', atMs = null, createdBy = 'local',
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
      pane: null,
      muxSession: null,
      leaseId: null,
    };
    state.promptQueue.push(entry);
    result = { ok: true, entry: { ...entry } };
    return state;
  });
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
    if (e.mode === 'now') return true;
    if (e.mode === 'at') return now >= e.atMs;
    // next-reset
    if (now < e.notBefore) return false;
    const resetAtMs = resolved[e.agent]?.resetAtMs ?? null;
    return resetAtMs === null || resetAtMs <= now;
  });
}
