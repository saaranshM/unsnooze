// User-facing subcommands: status, resume-now, cancel, logs.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { LOG_FILE, MAX_RESUME_ATTEMPTS } from './config.js';
import { readState, setStatus, updateState } from './state.js';
import { spawnResumerIfNeeded } from './spawn.js';

function fmtCountdown(ms) {
  if (ms <= 0) return 'due now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function cmdStatus() {
  const state = readState();
  const sessions = Object.values(state.sessions);
  if (sessions.length === 0) {
    console.log('unsnooze: no tracked sessions.');
    return 0;
  }
  const now = Date.now();
  console.log(`unsnooze: ${sessions.length} tracked session(s)  (resumer pid: ${state.resumerPid ?? 'not running'})\n`);
  for (const s of sessions.sort((a, b) => (a.resetAt || 0) - (b.resetAt || 0))) {
    const id = s.sessionId ? s.sessionId.slice(0, 8) : '(no id)';
    const reset = s.resetAt ? `${new Date(s.resetAt).toLocaleString()} (${fmtCountdown(s.resetAt - now)})` : '?';
    console.log(`  [${s.status.toUpperCase().padEnd(9)}] ${id}  ${s.limitType?.padEnd(7) ?? 'unknown'} ${s.cwd}`);
    console.log(`              pane ${s.pane ?? '-'} · resets ${reset} · attempts ${s.attempts ?? 0}/${MAX_RESUME_ATTEMPTS}${s.lastError ? ` · last error: ${s.lastError}` : ''}`);
  }
  return 0;
}

function selectKeys(state, idOrAll) {
  const stopped = Object.values(state.sessions).filter(s => s.status === 'stopped');
  if (idOrAll === '--all' || idOrAll === undefined) return stopped.map(s => s.key);
  const match = stopped.filter(s => s.key.startsWith(idOrAll) || (s.sessionId || '').startsWith(idOrAll));
  return match.map(s => s.key);
}

export function cmdResumeNow(idOrAll) {
  const state = readState();
  const keys = selectKeys(state, idOrAll);
  if (keys.length === 0) { console.log('unsnooze: no matching stopped sessions.'); return 1; }
  updateState(s => {
    for (const key of keys) if (s.sessions[key]) s.sessions[key].resetAt = Date.now();
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
