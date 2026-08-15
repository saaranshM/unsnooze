// Detached-process helpers shared by launcher, hook, and monitor.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { RESUMER_LOCK } from './config.js';
import { makeLogger } from './logger.js';

const log = makeLogger('spawn');

export const UNSNOOZE_BIN = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin', 'unsnooze.js');

export function spawnDetached(args, env = {}) {
  const child = spawn(process.execPath, [UNSNOOZE_BIN, ...args], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  });
  child.unref();
  return child.pid;
}

// The one definition of how a per-pane monitor is launched. The launcher uses
// it to start one; a version-skewed monitor uses it to hand off to its own
// replacement. Keeping a single builder is what stops the two from drifting —
// a mismatched respawn would silently watch the wrong pane or, with a null
// hole in the argv, throw inside child_process and take the watcher with it.
export function monitorSpawnArgs({ muxName, paneOwner, pane, agentId, leaseId }) {
  return ['_monitor', muxName, paneOwner || '', pane, agentId, leaseId || ''];
}

// Signal 0 probes for existence without delivering anything. Shared: the
// resumer's lock hygiene, the dashboard's liveness column, and the version-skew
// hand-off all need the same answer.
export function pidAlive(pid) {
  // Reject 0 before probing: kill(0, 0) targets our OWN process group and
  // succeeds, so a garbage lock file holding "0" would read as a live holder
  // forever. Number.isFinite alone does not catch it.
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Spawn the resumer daemon unless one is already running (pidfile check).
// The resumer itself re-checks under its own lock; this is just to avoid
// pointless spawns.
export function spawnResumerIfNeeded() {
  try {
    if (existsSync(RESUMER_LOCK)) {
      const pid = parseInt(readFileSync(RESUMER_LOCK, 'utf-8'), 10);
      if (Number.isFinite(pid) && pidAlive(pid)) return null;
    }
  } catch { /* unreadable lock — let the daemon sort it out */ }
  const pid = spawnDetached(['_resumer']);
  log(`spawned resumer pid ${pid}`);
  return pid;
}

// Stop a running resumer (if any): SIGTERM the lock pid, unlink the lock.
// Tolerates a dead/stale pid and a missing lock — uninstall must not fail.
export function stopResumer() {
  let pid = null;
  try {
    if (!existsSync(RESUMER_LOCK)) return { stopped: false, pid: null, reason: 'no-lock' };
    pid = parseInt(readFileSync(RESUMER_LOCK, 'utf-8'), 10);
    if (Number.isFinite(pid) && pidAlive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* raced with exit */ }
      log(`stopped resumer pid ${pid}`);
      try { unlinkSync(RESUMER_LOCK); } catch { /* gone */ }
      return { stopped: true, pid };
    }
    // Stale lock: clean up.
    try { unlinkSync(RESUMER_LOCK); } catch { /* gone */ }
    return { stopped: false, pid: Number.isFinite(pid) ? pid : null, reason: 'stale' };
  } catch (err) {
    try { unlinkSync(RESUMER_LOCK); } catch { /* best-effort */ }
    return { stopped: false, pid, reason: err.message };
  }
}
