import {
  mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { STATE_DIR } from './config.js';

const LEASES_DIR = join(STATE_DIR, 'leases');

export function addressHash({ mux, paneOwner, pane }) {
  return createHash('sha256')
    .update(`${mux ?? ''}\0${paneOwner ?? ''}\0${pane ?? ''}`)
    .digest('hex');
}

export function createLeaseId() {
  return randomUUID();
}

export function processBirth(pid, {
  platform = process.platform,
  readFile = path => readFileSync(path, 'utf-8'),
  execFile = (file, args) => execFileSync(file, args, { encoding: 'utf-8' }),
} = {}) {
  try {
    if (platform === 'linux') {
      const stat = readFile(`/proc/${pid}/stat`);
      const close = stat.lastIndexOf(')');
      if (close === -1) return null;
      // The tail begins at field 3 (state); starttime is field 22.
      return stat.slice(close + 1).trim().split(/\s+/)[19] || null;
    }
    if (platform === 'darwin') {
      return execFile('ps', ['-o', 'lstart=', '-p', String(pid)]).trim() || null;
    }
  } catch { /* fail closed */ }
  return null;
}

function leasePath(address, leaseId) {
  return join(LEASES_DIR, `${addressHash(address)}.${leaseId}.json`);
}

export function writeLease(lease) {
  mkdirSync(LEASES_DIR, { recursive: true });
  const path = leasePath(lease, lease.leaseId);
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(lease));
  renameSync(tmp, path);
  return lease;
}

export function readLease(address, leaseId) {
  try {
    const lease = JSON.parse(readFileSync(leasePath(address, leaseId), 'utf-8'));
    return lease.leaseId === leaseId ? lease : null;
  } catch {
    return null;
  }
}

export function removeLease(address, leaseId) {
  const path = leasePath(address, leaseId);
  const lease = readLease(address, leaseId);
  if (!lease || lease.leaseId !== leaseId) return false;
  try { unlinkSync(path); return true; } catch { return false; }
}

function defaultPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function leaseMatches(rec, {
  mux,
  pidAlive = defaultPidAlive,
  processBirthFn = processBirth,
} = {}) {
  if (!rec?.leaseId || !rec?.pane || !mux) return false;
  const stored = readLease(rec, rec.leaseId);
  if (!stored || stored.leaseId !== rec.leaseId || stored.agent !== rec.agent) return false;
  if (stored.mux !== rec.mux || stored.paneOwner !== rec.paneOwner || stored.pane !== rec.pane) return false;
  if (!pidAlive(stored.pid)) return false;
  const birth = processBirthFn(stored.pid);
  if (!birth || birth !== stored.pidBirth) return false;
  try { return await mux.paneAlive(rec.pane); } catch { return false; }
}
