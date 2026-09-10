// Codex rollout watcher: parses lines appended to session rollout files
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) into limit-stop candidates.
//
// Codex never persists Error/StreamError events to rollouts (confirmed in
// codex-rs/rollout policy), so the limit banner text is NOT in the file. What
// IS persisted is a token_count event per turn carrying a rate_limits
// snapshot — used_percent per window plus an exact resets_at epoch:
//   {"type":"event_msg","payload":{"type":"token_count","rate_limits":{
//     "primary":{"used_percent":100,"window_minutes":300,"resets_at":1778672230},
//     "secondary":{"used_percent":1,"window_minutes":10080,"resets_at":...},
//     "rate_limit_reached_type":null}}}
// That epoch is more precise than any scraped banner, and rollouts are shared
// by every Codex surface (CLI, IDE extension, desktop app).

import { openSync, readSync, closeSync } from 'node:fs';
import { basename } from 'node:path';
import { ROLLOUT_RE } from '../agents/codex.js';
// Usage extractor lives in usage.js (shared cold path + daemon); re-exported
// here so the plan's watcher surface is the documented import site.
export { extractCodexUsage } from '../usage.js';
// Label from window_minutes (300/10080/43200 → 5h/weekly/30d) — never assume
// 5h/weekly: the go plan's 43200-min window is monthly, and calibration keys
// must not conflate it with the weekly bucket.
import { labelWindow } from '../usage.js';

function rolloutSnapshot(line) {
  if (!line || !line.trim()) return null;
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  if (entry?.type !== 'event_msg' || entry.payload?.type !== 'token_count') return null;
  const rl = entry.payload.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  return entry;
}

function emptyPremium(rl) {
  return rl.limit_id === 'premium' && rl.primary === null && rl.secondary === null
    && rl.credits?.has_credits === false && rl.credits?.unlimited === false
    && rl.credits?.balance != null && rl.credits.balance !== ''
    && Number(rl.credits.balance) === 0;
}

// With several exhausted windows, the latest reset governs: resuming at an
// earlier one would immediately hit the other limit again.
function parseSnapshot(entry, previous = null) {
  if (!entry) return null;
  const rl = entry.payload.rate_limits;
  const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;

  const windows = ['primary', 'secondary']
    .map(k => rl[k])
    .filter(w => w && typeof w === 'object');
  let binding = null;
  const exhausted = windows.filter(w => (w.used_percent ?? 0) >= 100);
  if (exhausted.length > 0) {
    binding = exhausted.reduce((a, b) => ((b.resets_at || 0) > (a.resets_at || 0) ? b : a));
  } else if (rl.rate_limit_reached_type) {
    const named = rl[rl.rate_limit_reached_type];
    binding = (named && typeof named === 'object')
      ? named
      : windows.reduce((a, b) => ((b.resets_at || 0) > (a?.resets_at || 0) ? b : a), null);
  }
  // #20: Codex can stop at a reported 99%, then emit an empty premium bucket
  // instead of a 100% snapshot. Infer a stop only for that transition,
  // in the same rollout, within a minute, with no credits and a future reset.
  // A lone 99% snapshot or an unrelated premium bucket is not a stop.
  if (!binding && emptyPremium(rl) && previous) {
    const prior = previous.payload.rate_limits;
    const elapsed = ts - Date.parse(previous.timestamp);
    const primary = prior.primary;
    if (prior.limit_id === 'codex' && elapsed >= 0 && elapsed <= 60_000
        && primary?.window_minutes === 300
        && Number.isFinite(primary.used_percent) && primary.used_percent >= 99
        && Number.isFinite(primary.resets_at) && primary.resets_at * 1000 > ts) {
      binding = primary;
      const secondary = prior.secondary;
      if (Number.isFinite(secondary?.used_percent) && secondary.used_percent >= 100
          && Number.isFinite(secondary.resets_at) && secondary.resets_at > binding.resets_at) {
        binding = secondary;
      }
    }
  }
  if (!binding) return null;

  return {
    limitType: labelWindow(binding.window_minutes),
    resetAt: binding.resets_at ? binding.resets_at * 1000 : null,
    reachedType: rl.rate_limit_reached_type || null,
    timestampMs: Number.isFinite(ts) ? ts : null,
  };
}

export function parseRolloutLine(line) {
  return parseSnapshot(rolloutSnapshot(line));
}

// Look immediately before the appended batch, not at the file's current EOF:
// it may have grown since the watcher read it. This also works after restart
// without persisting another cache alongside the watcher's byte offsets.
function previousSnapshot(path, offset) {
  if (!path || !Number.isSafeInteger(offset) || offset <= 0) return null;
  let fd;
  try {
    fd = openSync(path, 'r');
    const length = Math.min(offset, 4 * 1024 * 1024);
    const buf = Buffer.alloc(length);
    const count = readSync(fd, buf, 0, length, offset - length);
    const lines = buf.subarray(0, count).toString('utf-8').split('\n');
    if (offset > length) lines.shift(); // the first line may be truncated
    for (let i = lines.length - 1; i >= 0; i--) {
      const snapshot = rolloutSnapshot(lines[i]);
      if (snapshot) return snapshot;
    }
  } catch { /* missing context means no inferred stop */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return null;
}

export function parseRolloutLines(lines, { path, offset } = {}) {
  let previous;
  const hits = [];
  for (const line of lines) {
    const snapshot = rolloutSnapshot(line);
    if (!snapshot) continue;
    if (previous === undefined && emptyPremium(snapshot.payload.rate_limits)) {
      previous = previousSnapshot(path, offset);
    }
    const hit = parseSnapshot(snapshot, previous);
    if (hit) hits.push(hit);
    previous = snapshot;
  }
  return hits;
}

// The session_meta head line can be very long (it embeds the full base
// instructions) — read in chunks until the first newline.
function readFirstLine(path, maxBytes = 256 * 1024) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const chunk = Buffer.alloc(16 * 1024);
    let head = '';
    let pos = 0;
    while (pos < maxBytes) {
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      head += chunk.toString('utf-8', 0, n);
      pos += n;
      const nl = head.indexOf('\n');
      if (nl !== -1) return head.slice(0, nl);
    }
    return head;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Session identity for a rollout file: the session_meta head line when
// parseable, else the uuid embedded in the filename.
export function rolloutMeta(path) {
  let sessionId = null;
  let cwd = null;
  let originator = null;
  try {
    const meta = JSON.parse(readFirstLine(path));
    if (meta?.type === 'session_meta') {
      sessionId = meta.payload?.id || null;
      cwd = meta.payload?.cwd || null;
      originator = meta.payload?.originator || null;
    }
  } catch { /* unreadable head — fall back to the filename */ }
  if (!sessionId) {
    const m = basename(path).match(ROLLOUT_RE);
    if (m) sessionId = m[1];
  }
  return { sessionId, cwd, originator };
}
