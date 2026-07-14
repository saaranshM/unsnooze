// User-facing subcommands: status, resume-now, cancel, logs, config, sessions, reap.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { LOG_FILE, MAX_RESUME_ATTEMPTS } from './config.js';
import { readState, setStatus, updateState } from './state.js';
import { getAgent } from './agents/index.js';
import { approxTokens } from './sessions.js';
import { getConfig, setConfigValue, listConfig, CONFIG_FILE } from './settings.js';
import { spawnResumerIfNeeded } from './spawn.js';
import { getMultiplexer } from './multiplexer.js';
import { listOwnedSessions, reap, attachHint } from './reap.js';

function fmtCountdown(ms) {
  if (ms <= 0) return 'due now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export async function cmdStatus() {
  const state = readState();
  const sessions = Object.values(state.sessions);
  const paused = !getConfig('autoResume');
  if (sessions.length === 0) {
    console.log(`unsnooze: no tracked sessions.${paused ? '  (PAUSED — auto-resume off)' : ''}`);
    return 0;
  }
  const now = Date.now();
  const pausedNote = paused ? '  PAUSED — auto-resume off (`unsnooze config set autoResume on`)' : '';
  console.log(`unsnooze: ${sessions.length} tracked session(s)  (resumer pid: ${state.resumerPid ?? 'not running'})${pausedNote}\n`);
  for (const s of sessions.sort((a, b) => (a.resetAt || 0) - (b.resetAt || 0))) {
    const id = s.sessionId ? s.sessionId.slice(0, 8) : '(no id)';
    const reset = s.resetAt ? `${new Date(s.resetAt).toLocaleString()} (${fmtCountdown(s.resetAt - now)})` : '?';
    const origin = s.origin ?? (s.pane ? 'cli' : '?');
    const pane = s.paneOwner ? `${s.paneOwner}:${s.pane ?? '-'}` : (s.pane ?? '-');
    const msg = s.resumeMessage
      ? ` · msg: "${s.resumeMessage.length > 44 ? s.resumeMessage.slice(0, 44) + '…' : s.resumeMessage}"`
      : '';
    const hold = s.workspaceHold
      ? ` · held: ${s.holdReason ?? '?'} — resume-now to wake`
      : '';
    // The price of waking: estimated context tokens the API re-reads cold.
    let ctx = '';
    if (s.status === 'stopped') {
      try {
        const t = getAgent(s.agent).contextTokens?.(s);
        if (t != null) ctx = ` · ctx ${approxTokens(t)} tok`;
      } catch { /* estimate unavailable — omit */ }
    }
    // Attach hint when the mux session the record points at is still live.
    let attach = '';
    if (s.muxSession) {
      try {
        const mux = getMultiplexer(s.mux || 'tmux');
        if (typeof mux.sessionExists === 'function' && await mux.sessionExists(s.muxSession)) {
          const hint = attachHint(s.mux, s.muxSession);
          if (hint) attach = ` · attach: ${hint}`;
        }
      } catch { /* mux unavailable — omit */ }
    }
    console.log(`  [${s.status.toUpperCase().padEnd(9)}] ${id}  ${(s.agent || 'claude').padEnd(6)} ${s.limitType?.padEnd(7) ?? 'unknown'} ${s.cwd}`);
    console.log(`              mux ${s.mux ?? '-'} · pane ${pane} · session ${s.muxSession ?? '-'} · via ${origin} · resets ${reset} · attempts ${s.attempts ?? 0}/${MAX_RESUME_ATTEMPTS}${s.lastError ? ` · last error: ${s.lastError}` : ''}${msg}${ctx}${hold}${attach}`);
  }
  return 0;
}

function selectKeys(state, idOrAll, statuses = ['stopped']) {
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
  console.log(`unsnooze: marked ${keys.length} session(s) due now; resumer dispatched.`);
  return 0;
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

// `unsnooze sessions` — list unsnooze-owned mux sessions with panes + records.
export async function cmdSessions() {
  const owned = await listOwnedSessions();
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
