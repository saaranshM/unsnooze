// User-facing subcommands: status, resume-now, cancel, logs, config, sessions, reap.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { LOG_FILE, MAX_RESUME_ATTEMPTS } from './config.js';
import { readState, setStatus, updateState } from './state.js';
import { getAgent } from './agents/index.js';
import { approxTokens } from './sessions.js';
import { getConfig, setConfigValue, listConfig, CONFIG_FILE } from './settings.js';
import { spawnResumerIfNeeded } from './spawn.js';
import { getMultiplexer } from './multiplexer.js';
import { listOwnedSessions, reap, attachHint } from './reap.js';
import { planFor } from './resumer.js';
import { queueList } from './prompt-queue.js';
import {
  shouldUseTui, formatStatusTui, formatSessionsTui, formatPreviewTui, logoBlock,
} from './tui.js';
import { shouldUseDashboard, runDashboard } from './dashboard/run.js';

function fmtCountdown(ms) {
  if (ms <= 0) return 'due now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Shared by status's cwd column and prompt.js's queue listings — collapse the
// home dir prefix to '~' the way most shells display it.
export function shortenHome(p) {
  if (typeof p !== 'string' || !p) return p;
  const home = homedir();
  if (p === home) return '~';
  return p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

// pending/launching are the only non-terminal prompt-queue statuses
// (delivered/failed/cancelled are terminal — see prompt-queue.js).
function pendingPromptEntries() {
  return queueList().filter(e => e.status === 'pending' || e.status === 'launching');
}

function fmtQueueDue(e, now) {
  if (Number.isFinite(e.notBefore) && e.notBefore > now) {
    return `backoff until ${new Date(e.notBefore).toLocaleString()}`;
  }
  if (e.mode === 'now') return 'now';
  if (e.mode === 'at') return new Date(e.atMs).toLocaleString();
  return 'next reset';
}

// Printed after the sessions report in the plain-text `unsnooze status` —
// silent (no section at all) when the queue has nothing pending, so the
// existing status output is byte-identical for everyone not using the queue.
function printPromptQueueSection(entries) {
  if (entries.length === 0) return;
  const now = Date.now();
  console.log(`\nqueued prompts: ${entries.length}\n`);
  for (const e of entries) {
    console.log(`  ${e.id}  ${(e.agent || 'claude').padEnd(8)} ${fmtQueueDue(e, now).padEnd(28)} ${e.status.padEnd(9)} ${shortenHome(e.cwd)}`);
  }
}


// Surface how the reset estimate was derived so a silent wrong guess can't hide.
export function fmtResetProvenance(s) {
  if (s.resetSource === 'fallback' || !s.resetSource) {
    return 'guessed: no reset time found — probing';
  }
  const via = s.detectedVia === 'transcript' ? 'transcript'
    : s.detectedVia === 'hook' ? 'hook'
    : s.detectedVia === 'scrape' ? 'scrape'
    : null;
  return via ? `${s.resetSource}, from ${via}` : s.resetSource;
}

export async function cmdStatus(args = []) {
  if (args.includes('--json')) {
    const state = readState();
    const daemonRunning = (() => {
      if (!state.resumerPid) return false;
      try { process.kill(state.resumerPid, 0); return true; } catch { return false; }
    })();
    console.log(JSON.stringify({
      version: 1,
      resumerPid: daemonRunning ? state.resumerPid : null,
      daemonRunning,
      paused: !getConfig('autoResume'),
      sessions: Object.values(state.sessions).map(s => ({
        key: s.key, sessionId: s.sessionId ?? null, agent: s.agent ?? 'claude',
        cwd: s.cwd ?? null, status: s.status, limitType: s.limitType ?? null,
        resetAt: s.resetAt ?? null, resetSource: s.resetSource ?? null,
        mux: s.mux ?? null, pane: s.pane ?? null, muxSession: s.muxSession ?? null,
        attempts: s.attempts ?? 0, lastError: s.lastError ?? null,
        workspaceHold: !!s.workspaceHold,
      })),
      promptQueue: queueList(),
    }, null, 2));
    return 0;
  }
  // Interactive TTY → live dashboard (until q). Pipes stay plain.
  if (shouldUseDashboard()) return runDashboard({ tab: 'status' });

  const state = readState();
  const sessions = Object.values(state.sessions);
  const paused = !getConfig('autoResume');
  const now = Date.now();
  const useTui = shouldUseTui();

  async function attachHintFor(s) {
    if (!s.muxSession) return null;
    try {
      const mux = getMultiplexer(s.mux || 'tmux');
      if (typeof mux.sessionExists === 'function' && await mux.sessionExists(s.muxSession)) {
        return attachHint(s.mux, s.muxSession) || null;
      }
    } catch { /* omit */ }
    return null;
  }
  function contextTokensFor(s) {
    return getAgent(s.agent).contextTokens?.(s);
  }

  if (useTui) {
    // Pre-resolve attach hints (async) for TUI cards.
    const attachMap = new Map();
    for (const s of sessions) {
      const h = await attachHintFor(s);
      if (h) attachMap.set(s.key, h);
    }
    console.log(formatStatusTui({
      sessions,
      resumerPid: state.resumerPid,
      paused,
      now,
      fmtCountdown,
      fmtResetProvenance,
      approxTokens,
      contextTokensFor,
      attachHintFor: s => attachMap.get(s.key) || null,
      color: true,
    }));
    return 0;
  }

  if (sessions.length === 0) {
    console.log(`unsnooze: no tracked sessions.${paused ? '  (PAUSED — auto-resume off)' : ''}`);
    printPromptQueueSection(pendingPromptEntries());
    return 0;
  }
  const pausedNote = paused ? '  PAUSED — auto-resume off (`unsnooze config set autoResume on`)' : '';
  console.log(`unsnooze: ${sessions.length} tracked session(s)  (resumer pid: ${state.resumerPid ?? 'not running'})${pausedNote}\n`);
  for (const s of sessions.sort((a, b) => (a.resetAt || 0) - (b.resetAt || 0))) {
    const id = s.sessionId ? s.sessionId.slice(0, 8) : '(no id)';
    const when = s.resetAt
      ? `${new Date(s.resetAt).toLocaleString()} (${fmtCountdown(s.resetAt - now)})`
      : '?';
    const reset = `${when} (${fmtResetProvenance(s)})`;
    const origin = s.origin ?? (s.pane ? 'cli' : '?');
    const pane = s.paneOwner ? `${s.paneOwner}:${s.pane ?? '-'}` : (s.pane ?? '-');
    const msg = s.resumeMessage
      ? ` · msg: "${s.resumeMessage.length > 44 ? s.resumeMessage.slice(0, 44) + '…' : s.resumeMessage}"`
      : '';
    const hold = s.workspaceHold
      ? ` · held: ${s.holdReason ?? '?'} — resume-now to wake`
      : '';
    let ctx = '';
    if (s.status === 'stopped') {
      try {
        const t = contextTokensFor(s);
        if (t != null) ctx = ` · ctx ${approxTokens(t)} tok`;
      } catch { /* estimate unavailable — omit */ }
    }
    let attach = '';
    const hint = await attachHintFor(s);
    if (hint) attach = ` · attach: ${hint}`;
    console.log(`  [${s.status.toUpperCase().padEnd(9)}] ${id}  ${(s.agent || 'claude').padEnd(6)} ${s.limitType?.padEnd(7) ?? 'unknown'} ${s.cwd}`);
    console.log(`              mux ${s.mux ?? '-'} · pane ${pane} · session ${s.muxSession ?? '-'} · via ${origin} · resets ${reset} · attempts ${s.attempts ?? 0}/${MAX_RESUME_ATTEMPTS}${s.lastError ? ` · last error: ${s.lastError}` : ''}${msg}${ctx}${hold}${attach}`);
  }
  printPromptQueueSection(pendingPromptEntries());
  return 0;
}

export function selectKeys(state, idOrAll, statuses = ['stopped']) {
  const candidates = Object.values(state.sessions).filter(s => statuses.includes(s.status));
  if (idOrAll === '--all' || idOrAll === undefined) return candidates.map(s => s.key);
  const match = candidates.filter(s => s.key.startsWith(idOrAll) || (s.sessionId || '').startsWith(idOrAll));
  return match.map(s => s.key);
}

export async function cmdResumeNow(idOrAll) {
  const state = readState();
  const keys = selectKeys(state, idOrAll);
  if (keys.length === 0) { console.log('unsnooze: no matching stopped sessions.'); return 1; }
  // The commenter's "show me the diff": held records print what moved since
  // the stop-time baseline before we wake them. Best-effort, never blocking.
  for (const key of keys) {
    const rec = state.sessions[key];
    if (rec?.workspaceHold && rec.workspace?.head && rec.cwd) {
      try {
        const { execFileSync } = await import('node:child_process');
        const stat = execFileSync('git', ['-C', rec.cwd, 'diff', '--stat', `${rec.workspace.head}..HEAD`],
          { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
        if (stat) console.log(`unsnooze: workspace changes since ${key.slice(0, 12)} stopped:\n${stat}`);
      } catch { /* repo gone or git unhappy — proceed anyway */ }
    }
  }
  markResumeNow(keys);
  console.log(`unsnooze: marked ${keys.length} session(s) due now; resumer dispatched.`);
  return 0;
}

// Shared core: mark sessions due now + manual (bypasses autoResume off and
// workspace/context guards), clear any hold, dispatch the resumer. Used by
// local `resume-now` and (future) remote-trigger fan-out — keep this the
// single place that owns the mutation semantics.
export function markResumeNow(keys) {
  updateState(s => {
    for (const key of keys) {
      if (s.sessions[key]) {
        s.sessions[key].resetAt = Date.now();
        s.sessions[key].manual = true;   // explicit user action beats autoResume=off + workspaceGuard
        delete s.sessions[key].workspaceHold;
        delete s.sessions[key].holdReason;
      }
    }
  });
  spawnResumerIfNeeded();
  return keys;
}

export function cmdCancel(idOrAll) {
  const state = readState();
  const keys = selectKeys(state, idOrAll);
  if (keys.length === 0) { console.log('unsnooze: no matching stopped sessions.'); return 1; }
  for (const key of keys) setStatus(key, 'cancelled');
  console.log(`unsnooze: cancelled ${keys.length} session(s).`);
  return 0;
}

export function cmdLogs(follow) {
  if (follow) {
    const r = spawnSync('tail', ['-f', LOG_FILE], { stdio: 'inherit' });
    return r.status ?? 0;
  }
  try {
    process.stdout.write(readFileSync(LOG_FILE, 'utf-8'));
  } catch {
    console.log('unsnooze: no log file yet.');
  }
  return 0;
}

// `unsnooze message <id|--all> <text...>` — set (or --clear) the wake message
// for specific sessions; the resumer prefers it over the global setting.
export function cmdMessage(rest) {
  const [idOrAll, ...textParts] = rest;
  const clear = textParts[0] === '--clear';
  const text = textParts.join(' ').trim();
  if (!idOrAll || (!clear && !text)) {
    console.error('unsnooze message <id|--all> <text...>   (or --clear to revert to the default)');
    return 2;
  }
  const state = readState();
  // stopped OR resuming: editing the message before a retry is legitimate.
  const keys = selectKeys(state, idOrAll, ['stopped', 'resuming']);
  if (keys.length === 0) { console.log('unsnooze: no matching active sessions.'); return 1; }
  updateState(s => {
    for (const key of keys) {
      if (!s.sessions[key]) continue;
      if (clear) delete s.sessions[key].resumeMessage;
      else s.sessions[key].resumeMessage = text;
    }
  });
  console.log(clear
    ? `unsnooze: cleared custom message on ${keys.length} session(s) (global default applies).`
    : `unsnooze: ${keys.length} session(s) will wake with: "${text}"`);
  return 0;
}

// `unsnooze config list | get <key> | set <key> <value>`
export function cmdConfig(rest) {
  const [action, key, ...valueParts] = rest;
  try {
    if (!action || action === 'list') {
      const listed = listConfig();
      console.log(`unsnooze settings (${CONFIG_FILE()}):\n`);
      for (const [k, v] of Object.entries(listed)) {
        console.log(`  ${k.padEnd(24)} ${JSON.stringify(v)}`);
      }
      return 0;
    }
    if (action === 'get') {
      if (!key) { console.error('unsnooze config get <key>'); return 2; }
      console.log(JSON.stringify(getConfig(key)));
      return 0;
    }
    if (action === 'set') {
      const value = valueParts.join(' ');
      // An explicit "" is a valid value (clears string overrides); only a
      // genuinely missing value is a usage error.
      if (!key || valueParts.length === 0) { console.error('unsnooze config set <key> <value>'); return 2; }
      const applied = setConfigValue(key, value);
      console.log(`unsnooze: ${key} = ${JSON.stringify(applied)}`);
      return 0;
    }
    console.error(`unsnooze config: unknown action "${action}" (list | get | set)`);
    return 2;
  } catch (err) {
    console.error(err.message);
    return 1;
  }
}

// `unsnooze preview [id]` — dry-run: what WOULD the resumer do right now,
// and why? Shares planFor/assessPane/evaluate*Guard with the real dispatch,
// so this can never drift from what dispatch actually does. Read-only pane
// captures only — nothing is typed, opened, or modified.
// Exit codes (terraform -detailed-exitcode style): 0 = nothing would wake
// right now, 2 = at least one actionable wake, 1 = internal error.
export async function cmdPreview(rest = [], {
  resolveMux = rec => getMultiplexer(rec.mux, { owner: rec.paneOwner }),
  matchesLease = undefined,
  print = console.log,
  now = Date.now(),
} = {}) {
  try {
    const idOrAll = rest.find(a => !a.startsWith('-'));
    const state = readState();
    let records = Object.values(state.sessions);
    if (idOrAll) {
      records = records.filter(s => s.key.startsWith(idOrAll) || (s.sessionId || '').startsWith(idOrAll));
    }
    if (records.length === 0) {
      print(idOrAll ? `unsnooze preview: no session matching "${idOrAll}".` : 'unsnooze preview: no tracked sessions.');
      return 0;
    }
    const VERBS = {
      inject: p => `would TYPE the wake message into pane ${p.target?.pane}`,
      'drive-menu': p => `would SELECT "Stop and wait for limit to reset" in pane ${p.target?.pane}`,
      reopen: p => `would REOPEN in session "${p.target?.session}"${p.messageViaPane ? ' and type the message once the TUI shows an idle prompt' : ' (message travels in argv)'}`,
      busy: () => 'would DEFER — agent is busy',
      'menu-held': () => 'limit menu on screen — would WAIT (menuAutoAnswer off)',
      probe: () => 'would PROBE (reset time unknown) — not a resume',
      waiting: () => 'waiting for the reset',
      paused: () => 'paused — would do nothing',
      held: () => 'held — would do nothing until resume-now',
      'give-up': () => 'would GIVE UP (attempt cap reached)',
      verifying: () => 'verifying an in-flight resume',
      retry: () => 'would RETRY later (pane capture failed)',
      none: () => 'nothing to do',
    };
    let actionable = false;
    const tuiEntries = [];
    const useTui = shouldUseTui() && print === console.log;
    if (!useTui) print('unsnooze preview — what WOULD happen right now (nothing is sent)\n');
    for (const rec of records.sort((x, y) => (x.resetAt || 0) - (y.resetAt || 0))) {
      let plan;
      try {
        plan = await planFor(rec, {
          mux: resolveMux(rec),
          ...(matchesLease ? { matchesLease } : {}),
          now,
        });
      } catch (err) {
        if (useTui) tuiEntries.push({ status: rec.status, id: rec.key.slice(0, 12), agent: rec.agent, cwd: rec.cwd, verb: `preview failed: ${err.message}`, gates: [] });
        else print(`  ${rec.key.slice(0, 12)}: preview failed: ${err.message}`);
        continue;
      }
      const id = rec.sessionId ? rec.sessionId.slice(0, 8) : '(no id)';
      const verb = (VERBS[plan.action] || (() => plan.action))(plan);
      let message = null;
      if (plan.message && ['inject', 'reopen'].includes(plan.action)) {
        message = plan.message.length > 140 ? `${plan.message.slice(0, 140)}…` : plan.message;
        message = message.replace(/\n+/g, ' ⏎ ');
      }
      if (useTui) {
        tuiEntries.push({ status: rec.status, id, agent: rec.agent, cwd: rec.cwd, verb, gates: plan.gates || [], message });
      } else {
        print(`  [${(rec.status || '?').toUpperCase().padEnd(9)}] ${id}  ${(rec.agent || 'claude').padEnd(6)} ${rec.cwd || ''}`);
        print(`              ${verb}`);
        for (const g of plan.gates) print(`              · ${g}`);
        if (message) print(`              message: "${message}"`);
      }
      if (['inject', 'drive-menu', 'reopen'].includes(plan.action)) actionable = true;
    }
    if (useTui) print(formatPreviewTui(tuiEntries, { color: true }));
    else print('\nNothing was typed, opened, or modified. `unsnooze resume-now <id>` wakes a session immediately.');
    return actionable ? 2 : 0;
  } catch (err) {
    console.error(`unsnooze preview: ${err.message}`);
    return 1;
  }
}

// `unsnooze sessions` — list unsnooze-owned mux sessions with panes + records.
export async function cmdSessions() {
  if (shouldUseDashboard()) return runDashboard({ tab: 'sessions' });
  const owned = await listOwnedSessions();
  if (shouldUseTui()) {
    console.log(formatSessionsTui(owned, { color: true }));
    return 0;
  }
  if (owned.length === 0) {
    console.log('unsnooze: no unsnooze-owned mux sessions found.');
    return 0;
  }
  console.log(`unsnooze: ${owned.length} mux session(s)\n`);
  for (const s of owned) {
    const flag = s.exited ? 'EXITED' : 'live';
    const panes = s.panes.length ? s.panes.join(', ') : '(none)';
    console.log(`  [${flag.padEnd(6)}] ${s.mux}  ${s.name}  panes: ${panes}`);
    if (s.attach) console.log(`              attach: ${s.attach}`);
    for (const r of s.records) {
      console.log(`              · ${r.status} ${(r.agent || '?').padEnd(6)} ${r.cwd || '?'} pane ${r.pane ?? '-'}`);
    }
  }
  return 0;
}

// `unsnooze reap [--dry-run|--yes]` — close terminal-record panes and empty/
// EXITED unsnooze sessions. Default is dry-run.
export async function cmdReap(rest = []) {
  // Default dry-run unless --yes.
  const yes = rest.includes('--yes');
  const result = await reap({ dryRun: !yes, yes });
  if (result.actions.length === 0) {
    console.log(result.dryRun
      ? 'unsnooze reap (dry-run): nothing to do.'
      : 'unsnooze reap: nothing to do.');
    return 0;
  }
  const prefix = result.dryRun ? 'unsnooze reap (dry-run)' : 'unsnooze reap';
  console.log(`${prefix}: ${result.actions.length} action(s)\n`);
  for (const a of result.actions) {
    if (a.kind === 'close-pane') {
      console.log(`  close pane ${a.mux} ${a.paneOwner ? `${a.paneOwner}:` : ''}${a.pane} (record ${a.key})`);
    } else if (a.kind === 'delete-session') {
      console.log(`  delete session ${a.mux} ${a.name} (${a.reason})`);
    } else if (a.kind === 'drop-record') {
      console.log(`  drop record ${a.key} (${a.reason})`);
    } else if (a.kind === 'error') {
      console.log(`  error: ${a.key || a.name}: ${a.message}`);
    } else {
      console.log(`  ${a.kind}: ${JSON.stringify(a)}`);
    }
  }
  if (result.dryRun) {
    console.log('\nRe-run with --yes to apply.');
  }
  return 0;
}
