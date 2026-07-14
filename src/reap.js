// Explicit process/session cleanup (`unsnooze sessions` / `unsnooze reap`).
// Never auto-kills a live agent pane unless the user opts in via reapResumed.

import { MUX_SESSION_NAME, RESUME_SESSION_NAME } from './config.js';
import { getMultiplexer } from './multiplexer.js';
import { readState, setStatus, updateState } from './state.js';
import { getConfig } from './settings.js';
import { makeLogger } from './logger.js';

const log = makeLogger('reap');

// How a user reaches a revived session. Shared by status, toast, and `sessions`.
export function attachHint(muxName, sessionName) {
  if (!sessionName) return null;
  if (muxName === 'zellij') return `zellij attach ${sessionName}`;
  return `tmux attach -t ${sessionName}`;
}

// A session name is unsnooze-owned if it is the interactive base, a collision
// suffix (`unsnooze-2`…), the dedicated resume session, or a pid fallback.
export function isUnsnoozeSessionName(name, base = MUX_SESSION_NAME) {
  if (!name || typeof name !== 'string') return false;
  if (name === base) return true;
  if (name === RESUME_SESSION_NAME) return true;
  if (name === `${base}-resumed`) return true;
  // base-N / base-<pid>
  if (name.startsWith(`${base}-`) && /^[0-9]+$/.test(name.slice(base.length + 1))) return true;
  return false;
}

export async function listOwnedSessions({ muxName = null } = {}) {
  const names = muxName ? [muxName] : ['tmux', 'zellij'];
  const out = [];
  for (const name of names) {
    let mux;
    try { mux = getMultiplexer(name); } catch { continue; }
    if (!mux.available?.()) continue;
    if (typeof mux.listSessions !== 'function') continue;
    let sessions = [];
    try { sessions = await mux.listSessions(); } catch { continue; }
    for (const row of sessions) {
      if (!isUnsnoozeSessionName(row.name)) continue;
      let panes = [];
      try {
        const bound = mux.bind ? mux.bind(row.name) : mux;
        panes = typeof bound.listSessionPanes === 'function'
          ? await bound.listSessionPanes(row.name)
          : [];
      } catch { panes = []; }
      // Match records that live in this session.
      const records = Object.values(readState().sessions).filter(s =>
        (s.muxSession === row.name || s.paneOwner === row.name)
        && (!s.mux || s.mux === name));
      out.push({
        mux: name,
        name: row.name,
        exited: !!row.exited,
        panes,
        records: records.map(r => ({
          key: r.key,
          status: r.status,
          agent: r.agent,
          cwd: r.cwd,
          pane: r.pane,
        })),
        attach: attachHint(name, row.name),
      });
    }
  }
  return out;
}

// Close panes for terminal records and remove empty/exited unsnooze sessions.
// dryRun (default true) only reports what would happen.
export async function reap({
  dryRun = true,
  yes = false,
  resolveMux = rec => getMultiplexer(rec.mux, { owner: rec.paneOwner }),
} = {}) {
  // --yes flips dry-run off; plain default stays dry-run.
  if (yes) dryRun = false;
  const actions = [];
  const state = readState();
  const terminal = Object.values(state.sessions).filter(s =>
    ['resumed', 'failed', 'cancelled'].includes(s.status) && s.pane);

  for (const rec of terminal) {
    let alive = false;
    try {
      const mux = resolveMux(rec);
      alive = await mux.paneAlive(rec.pane);
    } catch { alive = false; }
    if (!alive) {
      actions.push({ kind: 'drop-record', key: rec.key, reason: 'pane already dead' });
      if (!dryRun) {
        updateState(s => { delete s.sessions[rec.key]; return s; });
      }
      continue;
    }
    actions.push({
      kind: 'close-pane',
      key: rec.key,
      mux: rec.mux,
      pane: rec.pane,
      paneOwner: rec.paneOwner,
      session: rec.muxSession,
    });
    if (!dryRun) {
      try {
        const mux = resolveMux(rec);
        if (typeof mux.closePane === 'function') await mux.closePane(rec.pane);
        setStatus(rec.key, rec.status, { pane: null });
        updateState(s => { delete s.sessions[rec.key]; return s; });
      } catch (err) {
        actions.push({ kind: 'error', key: rec.key, message: err.message });
      }
    }
  }

  // Empty / EXITED unsnooze-owned sessions.
  for (const name of ['tmux', 'zellij']) {
    let mux;
    try { mux = getMultiplexer(name); } catch { continue; }
    if (!mux.available?.() || typeof mux.listSessions !== 'function') continue;
    let sessions = [];
    try { sessions = await mux.listSessions(); } catch { continue; }
    for (const row of sessions) {
      if (!isUnsnoozeSessionName(row.name)) continue;
      const bound = mux.bind ? mux.bind(row.name) : mux;
      let panes = [];
      try {
        panes = typeof bound.listSessionPanes === 'function'
          ? await bound.listSessionPanes(row.name)
          : [];
      } catch { panes = []; }
      const empty = panes.length === 0;
      const exited = !!row.exited;
      // tmux auto-destroys empty sessions; only act when empty (or EXITED for zellij).
      if (!empty && !exited) continue;
      actions.push({
        kind: 'delete-session',
        mux: name,
        name: row.name,
        reason: exited ? 'exited' : 'empty',
      });
      if (!dryRun && typeof bound.deleteSession === 'function') {
        try { await bound.deleteSession(row.name); }
        catch (err) {
          actions.push({ kind: 'error', name: row.name, message: err.message });
        }
      }
    }
  }

  return { dryRun, actions };
}

// Optional auto-reap of long-idle `resumed` panes when reapResumed is on.
export async function autoReapIfEnabled({
  resolveMux = rec => getMultiplexer(rec.mux, { owner: rec.paneOwner }),
  now = Date.now(),
} = {}) {
  if (!getConfig('reapResumed')) return 0;
  const idleAfter = getConfig('reapIdleAfter');
  let closed = 0;
  for (const rec of Object.values(readState().sessions)) {
    if (rec.status !== 'resumed' || !rec.pane) continue;
    const ts = rec.lastAttemptAt || rec.detectedAt || 0;
    if (ts > now - idleAfter) continue;
    try {
      const mux = resolveMux(rec);
      if (!(await mux.paneAlive(rec.pane))) {
        updateState(s => { delete s.sessions[rec.key]; return s; });
        continue;
      }
      if (typeof mux.closePane === 'function') {
        await mux.closePane(rec.pane);
        closed += 1;
        log(`${rec.key}: auto-reaped idle resumed pane ${rec.pane}`);
      }
      updateState(s => { delete s.sessions[rec.key]; return s; });
    } catch (err) {
      log(`${rec.key}: auto-reap failed: ${err.message}`);
    }
  }
  return closed;
}
