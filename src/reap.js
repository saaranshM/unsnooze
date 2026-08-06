// Explicit process/session cleanup (`unsnooze sessions` / `unsnooze reap`).
// Never auto-kills a live agent pane unless the user opts in via reapResumed.

import { MUX_SESSION_NAME, RESUME_SESSION_NAME } from './config.js';
import { getMultiplexer } from './multiplexer.js';
import { readState, updateState } from './state.js';
import { getConfig } from './settings.js';
import { paneOwnedByRecord } from './lease.js';
import { makeLogger } from './logger.js';

const log = makeLogger('reap');

function samePaneGeneration(a, b) {
  return !!(a?.pane && b?.pane && a.leaseId && b.leaseId
    && a.mux === b.mux && a.paneOwner === b.paneOwner && a.pane === b.pane
    && a.leaseId === b.leaseId);
}

function sameRecordEpisode(a, b) {
  return !!(a && b && a.status === b.status && a.pane === b.pane
    && a.mux === b.mux && a.paneOwner === b.paneOwner && a.leaseId === b.leaseId
    && (a.bannerAt ?? a.detectedAt) === (b.bannerAt ?? b.detectedAt)
    && (a.resumeEpisodeAt ?? null) === (b.resumeEpisodeAt ?? null));
}

function activePaneAlias(state, rec) {
  return Object.values(state.sessions).find(other => other.key !== rec.key
    && ['stopped', 'resuming', 'resumed'].includes(other.status)
    && samePaneGeneration(rec, other));
}

// Reserve a close under the state lock immediately before touching the mux.
// Removing the terminal record is the claim: another reap cannot close it,
// and a live alias that appeared during an awaited ownership probe wins.
function claimPaneClose(rec) {
  let result = { kind: 'stale' };
  updateState(state => {
    const current = state.sessions[rec.key];
    if (!sameRecordEpisode(current, rec)) return state;
    const alias = activePaneAlias(state, current);
    delete state.sessions[rec.key];
    if (alias) {
      result = { kind: 'alias', alias };
    } else if ((state.paneClosures || []).some(c => samePaneGeneration(c, current))) {
      result = { kind: 'closing' };
    } else {
      state.paneClosures ||= [];
      state.paneClosures.push({
        mux: current.mux,
        paneOwner: current.paneOwner,
        pane: current.pane,
        leaseId: current.leaseId,
        claimedAt: Date.now(),
      });
      result = { kind: 'claimed' };
    }
    return state;
  });
  return result;
}

function dropIfUnchanged(rec) {
  let dropped = false;
  updateState(state => {
    if (sameRecordEpisode(state.sessions[rec.key], rec)) {
      delete state.sessions[rec.key];
      dropped = true;
    }
    return state;
  });
  return dropped;
}

function restoreFailedClaim(rec) {
  updateState(state => {
    state.paneClosures = (state.paneClosures || []).filter(c => !samePaneGeneration(c, rec));
    if (!state.sessions[rec.key] && !activePaneAlias(state, rec)) {
      state.sessions[rec.key] = rec;
    }
    return state;
  });
}

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
  const terminal = Object.values(readState().sessions).filter(s =>
    ['resumed', 'failed', 'cancelled'].includes(s.status) && s.pane);

  const reapIdleAfter = getConfig('reapIdleAfter');
  const now = Date.now();
  for (const rec of terminal) {
    // 'resumed' is not really terminal — the agent may be mid-task in that
    // pane right now. Honor the module contract ("never kill a live agent")
    // by requiring the same idle threshold as auto-reap before closing.
    if (rec.status === 'resumed') {
      const ts = rec.lastAttemptAt || rec.detectedAt || 0;
      if (ts > now - reapIdleAfter) {
        actions.push({ kind: 'skip-active', key: rec.key, pane: rec.pane,
          reason: `resumed and active within reapIdleAfter — not closing` });
        continue;
      }
    }
    let alive = false;
    let mux = null;
    try {
      mux = resolveMux(rec);
      alive = await mux.paneAlive(rec.pane);
    } catch { alive = false; }
    if (!alive) {
      actions.push({ kind: 'drop-record', key: rec.key, reason: 'pane already dead' });
      if (!dryRun) dropIfUnchanged(rec);
      continue;
    }
    // Pane ids get recycled — closing by bare id could kill someone else's
    // pane. Positive ownership (stamp or lease) is required to close; a
    // demonstrably foreign pane means the record is stale, so drop it.
    let owned = null;
    try { owned = await paneOwnedByRecord(rec, { mux }); } catch { owned = null; }
    if (owned === false) {
      actions.push({ kind: 'drop-record', key: rec.key, reason: 'pane recycled — not ours' });
      if (!dryRun) dropIfUnchanged(rec);
      continue;
    }
    if (owned === null) {
      // Legacy record with no lease: no proof either way — never close.
      actions.push({ kind: 'skip-unowned', key: rec.key, pane: rec.pane,
        reason: 'ownership unprovable (pre-lease record) — close it manually' });
      continue;
    }
    if (dryRun) {
      const alias = activePaneAlias(readState(), rec);
      if (alias) {
        actions.push({ kind: 'drop-record', key: rec.key,
          reason: `pane is shared with active record ${alias.key} — not closing` });
        continue;
      }
    } else {
      // paneAlive() and ownership checks await external commands. Re-check and
      // claim only now so an owner created while they ran cannot be killed.
      const claim = claimPaneClose(rec);
      if (claim.kind === 'alias') {
        actions.push({ kind: 'drop-record', key: rec.key,
          reason: `pane is shared with active record ${claim.alias.key} — not closing` });
        continue;
      }
      if (claim.kind === 'closing') {
        actions.push({ kind: 'drop-record', key: rec.key,
          reason: 'pane generation is already being closed by another reap' });
        continue;
      }
      if (claim.kind !== 'claimed') {
        actions.push({ kind: 'skip-stale', key: rec.key, pane: rec.pane,
          reason: 'record changed while checking pane — not closing' });
        continue;
      }
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
        if (typeof mux.closePane === 'function') await mux.closePane(rec.pane);
      } catch (err) {
        restoreFailedClaim(rec);
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
        dropIfUnchanged(rec);
        continue;
      }
      // Same recycled-pane rule as reap(): positive ownership or no close.
      const owned = await paneOwnedByRecord(rec, { mux });
      if (owned !== true) {
        if (owned === false) {
          dropIfUnchanged(rec);
          log(`${rec.key}: auto-reap skipped — pane ${rec.pane} recycled, record dropped`);
        }
        continue;
      }
      const claim = claimPaneClose(rec);
      if (claim.kind !== 'claimed') continue;
      if (typeof mux.closePane === 'function') {
        try {
          await mux.closePane(rec.pane);
          closed += 1;
          log(`${rec.key}: auto-reaped idle resumed pane ${rec.pane}`);
        } catch (err) {
          restoreFailedClaim(rec);
          throw err;
        }
      }
    } catch (err) {
      log(`${rec.key}: auto-reap failed: ${err.message}`);
    }
  }
  return closed;
}
