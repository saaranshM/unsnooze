// Stale-workspace guard: fingerprint a repo when a session stops, compare at
// wake time. If another session (or a human) moved the repo meanwhile, the
// resumer either warns the agent in the wake message or holds the session,
// per the `workspaceGuard` setting. Non-git directories fingerprint to null
// and are never guarded.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500,
  }).toString().trim();
}

export function workspaceFingerprint(cwd) {
  if (!cwd) return null;
  try {
    const head = git(cwd, ['rev-parse', 'HEAD']);
    const dirty = git(cwd, ['status', '--porcelain']);
    return { head, dirtyHash: createHash('sha1').update(dirty).digest('hex') };
  } catch {
    return null;   // not a git repo / git missing / unreadable — skip the guard
  }
}

// null → nothing to report (no baseline, no current, or identical).
export function workspaceChanged(rec, current) {
  const before = rec?.workspace;
  if (!before || !current) return null;
  if (before.head === current.head && before.dirtyHash === current.dirtyHash) return null;
  return {
    oldHead: before.head,
    newHead: current.head,
    dirtyChanged: before.dirtyHash !== current.dirtyHash,
  };
}

export function describeChange(d) {
  const parts = [];
  if (d.oldHead !== d.newHead) parts.push(`HEAD ${d.oldHead.slice(0, 7)} → ${d.newHead.slice(0, 7)}`);
  if (d.dirtyChanged) parts.push('uncommitted changes differ');
  return parts.join('; ');
}
