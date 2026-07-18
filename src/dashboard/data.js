import { readFileSync, existsSync, statSync } from 'node:fs';
import { readState } from '../state.js';
import { getConfig } from '../settings.js';
import { LOG_FILE } from '../config.js';
import { queueList } from '../prompt-queue.js';
import {
  buildUsageReport,
  collectClaudeSamples,
  collectCodexSamples,
  readExactClaudeFromStatusline,
  parseUsageWarnAt,
  readUsageStore,
} from '../usage.js';
import { listOwnedSessions } from '../reap.js';
import { runDoctor } from '../doctor.js';
import { fetchFleet, readHosts } from '../fleet.js';

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function loadStatusSnapshot() {
  const state = readState();
  const sessions = Object.values(state.sessions || {});
  const daemonRunning = pidAlive(state.resumerPid);
  return {
    sessions,
    // A recorded pid that no longer answers is stale — never show it as live.
    resumerPid: daemonRunning ? state.resumerPid : null,
    daemonRunning,
    paused: !getConfig('autoResume'),
    now: Date.now(),
    promptQueue: queueList(),
  };
}

export async function loadUsageSnapshot() {
  const now = Date.now();
  const state = readState();
  const store = readUsageStore();
  // Throttled cold scan — callers should not fire more than every ~5s
  const claudeSamples = collectClaudeSamples({ now });
  const codexSamples = collectCodexSamples({ now });
  const exactClaude = readExactClaudeFromStatusline({ now });
  const report = buildUsageReport({
    now,
    claudeSamples: [
      ...(store.samples || []).filter(s => s.agent === 'claude' && s.weighted != null),
      ...claudeSamples,
    ],
    codexSamples: [
      ...(store.samples || []).filter(s => s.agent === 'codex' && s.primary),
      ...codexSamples,
    ],
    calibration: state.calibration || {},
    exactClaude,
    ewma: store.ewma || {},
    sessions: state.sessions,
    exactPctHistory: store.exactPct?.claude5h || [],
  });
  report.daemonRunning = (() => {
    if (!state.resumerPid) return false;
    try { process.kill(state.resumerPid, 0); return true; } catch { return false; }
  })();
  report.warnAt = parseUsageWarnAt(getConfig('usageWarnAt'));
  return report;
}

export async function loadSessionsSnapshot() {
  return listOwnedSessions();
}

export async function loadDoctorSnapshot() {
  return runDoctor({});
}

// Thin wrapper over fetchFleet() — ssh fan-out is per-host timeout-bounded
// there, so this can just be awaited like loadUsageSnapshot. `dest` and the
// full host `entry` (descriptor: dest/auth/source/env/service/account/cmd)
// are stitched back onto each result (fetchHost doesn't carry either) so
// tabs can build ssh -t attach hints and so App.js's R/C actions can pass
// the whole descriptor into remoteAction — a bare dest string loses the
// auth fields, which silently downgrades password hosts to key auth.
export async function loadFleetSnapshot() {
  const hosts = readHosts();
  const results = await fetchFleet({ hosts });
  return results.map(r => ({ ...r, dest: hosts[r.host]?.dest, entry: hosts[r.host] }));
}

// Flat (host, dest, entry, session) rows for every stopped session across
// the fleet, in host order — the single source of truth for row ordering so
// FleetTab's rendered list and App's selection/keybinding math never drift
// apart. `entry` (the full host descriptor) rides along so R/C actions can
// hand remoteAction auth-aware args instead of a bare dest string.
export function flattenFleetStopped(fleetData) {
  if (!fleetData) return [];
  const out = [];
  for (const r of fleetData) {
    const sessions = (r.envelope?.sessions ?? []).filter(s => s.status === 'stopped');
    for (const s of sessions) out.push({ host: r.host, dest: r.dest || r.host, entry: r.entry, session: s });
  }
  return out;
}

export function loadLogsSnapshot({ maxLines = 40 } = {}) {
  if (!existsSync(LOG_FILE)) return { lines: [], path: LOG_FILE, missing: true };
  try {
    const text = readFileSync(LOG_FILE, 'utf-8');
    const lines = text.split('\n').filter(Boolean).slice(-maxLines);
    return { lines, path: LOG_FILE, missing: false, size: statSync(LOG_FILE).size };
  } catch (err) {
    return { lines: [`(read error: ${err.message})`], path: LOG_FILE, missing: false };
  }
}

export function fmtCountdown(ms) {
  if (ms <= 0) return 'due now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Gauge with eighth-block partials for sub-cell precision (▏▎▍▌▋▊▉█).
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

export function bar(pct, width = 16) {
  const p = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  const cells = (p / 100) * width;
  const full = Math.floor(cells);
  const rem = Math.round((cells - full) * 8);
  const partial = full < width ? EIGHTHS[Math.min(rem, 7)] : '';
  const used = full + (partial ? 1 : 0);
  return '█'.repeat(full) + partial + '░'.repeat(Math.max(0, width - used));
}

export function countdownPct(resetAt, now = Date.now(), windowMs = 5 * 3_600_000) {
  if (!Number.isFinite(resetAt)) return null;
  const remain = resetAt - now;
  if (remain <= 0) return 100;
  return Math.min(100, Math.max(0, 100 - (remain / windowMs) * 100));
}
