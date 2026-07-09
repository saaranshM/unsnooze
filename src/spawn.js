// Detached-process helpers shared by launcher, hook, and monitor.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

function pidAlive(pid) {
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
