// Codex rollout watcher: parses lines appended to session rollout files
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) into limit-stop candidates.
//
// Two signals are persisted, and either one is a stop:
//
// 1. A token_count event per turn carrying a rate_limits snapshot —
//    used_percent per window plus an exact resets_at epoch:
//      {"type":"event_msg","payload":{"type":"token_count","rate_limits":{
//        "primary":{"used_percent":100,"window_minutes":300,"resets_at":1778672230},
//        "secondary":{"used_percent":1,"window_minutes":10080,"resets_at":...},
//        "rate_limit_reached_type":null}}}
//    That epoch is more precise than any scraped banner, so it governs
//    whenever it is present.
//
// 2. Since codex-cli 0.145 the failed turn's task_complete carries the
//    error itself, with the same banner text the TUI renders:
//      {"type":"event_msg","payload":{"type":"task_complete","error":{
//        "message":"You've hit your usage limit. … try again at Jul 30th, 2026 10:33 AM.",
//        "codex_error_info":"usage_limit_exceeded"}}}
//    This is the ONLY signal when Codex runs behind an OpenAI-compatible
//    proxy (model_providers.<x>.base_url): the proxy answers with its own
//    response, the X-Codex-* rate-limit headers never reach Codex, and every
//    snapshot arrives as {primary:null, secondary:null}. The message goes
//    through the same time-parser as a scraped pane, so the reset lands on
//    the banner's own clock time (or the probe fallback for "Try again later.").
//
// Rollouts are shared by every Codex surface (CLI, IDE extension, desktop app).
// A bare 429 ("exceeded retry limit, last status: 429 Too Many Requests",
// codex_error_info.response_too_many_failed_attempts) is NOT a stop here —
// it carries no reset time, and the pane path files it under transient
// overload for the same reason.

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { ROLLOUT_RE, rolloutPathFor, patterns as codexPatterns } from '../agents/codex.js';
import { detectLimit } from '../patterns.js';
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

// The failed turn's task_complete error, when it is a usage limit. The turn
// also ends in task_complete for stream errors, retry exhaustion and
// cancellations, so only the banner itself qualifies — not the structured
// marker alone: codex-rs (protocol/src/error.rs, to_codex_protocol_error)
// sends codex_error_info "usage_limit_exceeded" for "Quota exceeded. Check
// your plan and billing details." and "To use Codex with your ChatGPT plan,
// upgrade to Plus…" too, which no amount of waiting clears. Every real usage
// limit it words ("You’ve hit your usage limit…", "Your workspace is out of
// credits…", "You hit your spend cap…") carries a banner anchor.
// codex-rs words the workspace walls (UsageLimitReachedError's Display):
// "Your workspace is out of credits. …" and "You hit your spend cap set …".
const WORKSPACE_WALL_BANNER = /Your workspace is out of credits|hit your spend cap/i;

function rolloutLimitError(line) {
  // Every line that is not a snapshot lands here, and rollout lines can be
  // large (tool output): skip the second JSON.parse unless it can be a match.
  if (!line || !line.includes('"task_complete"')) return null;
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  if (entry?.type !== 'event_msg' || entry.payload?.type !== 'task_complete') return null;
  const error = entry.payload.error;
  if (!error || typeof error !== 'object') return null;
  const message = typeof error.message === 'string' ? error.message.trim() : '';
  if (!message) return null;
  // The message as pane text, with the same anchors and the same reset-line
  // selection as the scraped TUI — so the two paths cannot disagree about a
  // banner. All of it (tail 0): a message that wraps its reset time onto a
  // second line must still be read whole.
  const detected = detectLimit(message, 0, codexPatterns);
  if (!detected.hit) return null;
  const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  // A workspace wall says what it is in words, with no time to try again at.
  // Behind a proxy no snapshot is there to classify it, so the banner files
  // it the way parseSnapshot files a workspace reason with no spent window:
  // a model limit — probed, then held for a human, never woken into.
  const wall = WORKSPACE_WALL_BANNER.test(message);
  return {
    limitType: wall ? 'model' : detected.limitType,
    resetAt: null,
    resetLine: wall ? null : (detected.resetLine || message),
    reachedType: null,
    timestampMs: Number.isFinite(ts) ? ts : null,
  };
}

function emptyPremium(rl) {
  if (!(rl.limit_id === 'premium' && rl.primary === null && rl.secondary === null
    && rl.credits?.has_credits === false && rl.credits?.unlimited === false)) return false;
  if (rl.credits?.balance != null && rl.credits.balance !== '') {
    return Number(rl.credits.balance) === 0;
  }
  // Workspace plans (Business/Team) send the same empty bucket with no balance
  // at all, and say why in rate_limit_reached_type instead.
  return workspaceWall(rl.rate_limit_reached_type);
}

// rate_limit_reached_type names WHY the server refused, never a window. The
// enum (codex-rs/protocol) is rate_limit_reached and four workspace_* values:
// {owner,member}_credits_depleted and {owner,member}_usage_limit_reached. The
// workspace ones are a wall that no window reset takes down by itself: Codex
// words them "Your workspace is out of credits…" / "You hit your spend cap…",
// with no time to try again at. A window that is spent as well is another
// matter — its reset brings the plan's own allowance back (parseSnapshot).
function workspaceWall(reachedType) {
  return typeof reachedType === 'string' && reachedType.startsWith('workspace_');
}

// A window counts as spent from 99%: the server reports fractions, and #20's
// real stop read 99.0 (the same line the empty-premium inference draws).
const SPENT_PERCENT = 99;

// The window a "limit reached" is about when none reads 100: the one nearest
// exhaustion, primary on a tie. The server reports fractional percentages and
// #20's real stop read 99.0, so ">= 100" alone is not the whole story. (The
// previous rule took the window with the LATEST reset, which for any
// rate_limit_reached under 100% was the weekly one — days out.)
function nearestExhausted(windows) {
  return windows.reduce((a, b) => ((b.used_percent ?? 0) > (a?.used_percent ?? -1) ? b : a), null);
}

// With several exhausted windows, the latest reset governs: resuming at an
// earlier one would immediately hit the other limit again.
function parseSnapshot(entry, previous = null) {
  if (!entry) return null;
  const rl = entry.payload.rate_limits;
  const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  const reachedType = rl.rate_limit_reached_type || null;

  const windows = ['primary', 'secondary']
    .map(k => rl[k])
    .filter(w => w && typeof w === 'object');
  let binding = null;
  // The rate-limit bucket the binding window belongs to (Codex defaults a
  // missing limit_id to "codex"). parseRolloutLines pairs errors by it.
  let bucket = rl.limit_id ?? 'codex';
  const exhausted = windows.filter(w => (w.used_percent ?? 0) >= 100);
  if (exhausted.length > 0) {
    binding = exhausted.reduce((a, b) => ((b.resets_at || 0) > (a.resets_at || 0) ? b : a));
  } else if (workspaceWall(reachedType) && windows.length > 0) {
    const spent = windows.filter(w => (w.used_percent ?? 0) >= SPENT_PERCENT);
    if (spent.length > 0) {
      // The plan's window is spent too (99.x% is as spent as 100): its reset
      // brings the allowance back, so it governs exactly like an exhausted
      // one — otherwise the same stop reads as a waitable 5h stop at 100.0
      // and as a wall to hold for a human at 99.9.
      binding = spent.reduce((a, b) => ((b.resets_at || 0) > (a.resets_at || 0) ? b : a));
    } else {
      // Out of credits (or over the workspace cap) with no window spent:
      // there is no reset to sleep until. Record it the way a model limit is
      // recorded — no reset time, so the resumer probes and, at the ceiling,
      // makes the stall visible with the adapter's remedy instead of waking
      // into the same wall (#25 saw one of these scheduled as a 5h stop).
      // Only from a snapshot that describes windows: a credits-only bucket
      // (premium/null) carrying the reason must not re-file the 5h stop the
      // account bucket recorded a moment earlier as a probe.
      return {
        limitType: 'model',
        resetAt: null,
        reachedType,
        timestampMs: Number.isFinite(ts) ? ts : null,
        bucket,
      };
    }
  } else if (reachedType) {
    binding = nearestExhausted(windows);
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
      bucket = prior.limit_id;
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
    reachedType,
    timestampMs: Number.isFinite(ts) ? ts : null,
    bucket,
  };
}

export function parseRolloutLine(line) {
  return parseSnapshot(rolloutSnapshot(line)) || rolloutLimitError(line);
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

// A snapshot stop and the task_complete error of the same turn describe one
// event: keep the epoch (exact) and let the banner only fill in what the
// snapshot lacks. Bound the pairing to the same batch and a short window so a
// stale exhausted snapshot never lends its epoch to a later, unrelated stop —
// and to a stop that still stands when the error is written: its epoch must
// not have passed yet, and no later reading of the same bucket may show it
// cleared. Only the same bucket: Codex writes one token_count line per
// rate-limit bucket per response, so a healthy `codex_other` line right after
// an exhausted account line says nothing about the account.
const SNAPSHOT_PAIR_WINDOW_MS = 5 * 60_000;

function describesWindows(rl) {
  return ['primary', 'secondary'].some(k => rl[k] && typeof rl[k] === 'object');
}

export function parseRolloutLines(lines, { path, offset } = {}) {
  let previous;
  let lastSnapshotHit = null;
  const hits = [];
  for (const line of lines) {
    const snapshot = rolloutSnapshot(line);
    if (snapshot) {
      if (previous === undefined && emptyPremium(snapshot.payload.rate_limits)) {
        previous = previousSnapshot(path, offset);
      }
      const hit = parseSnapshot(snapshot, previous);
      if (hit) {
        hits.push(hit);
        lastSnapshotHit = hit;
      } else if (lastSnapshotHit) {
        const rl = snapshot.payload.rate_limits;
        if ((rl.limit_id ?? 'codex') === lastSnapshotHit.bucket && describesWindows(rl)) {
          lastSnapshotHit = null;
        }
      }
      previous = snapshot;
      continue;
    }
    const error = rolloutLimitError(line);
    if (!error) continue;
    const stop = lastSnapshotHit;
    const paired = stop
      && Number.isFinite(error.timestampMs) && Number.isFinite(stop.timestampMs)
      && error.timestampMs >= stop.timestampMs
      && error.timestampMs - stop.timestampMs <= SNAPSHOT_PAIR_WINDOW_MS
      // A workspace wall has no epoch to lend, and pairs anyway (below).
      && (stop.resetAt ? stop.resetAt > error.timestampMs : stop.limitType === 'model');
    if (paired) {
      error.resetAt = stop.resetAt;
      error.reachedType = stop.reachedType;
      if (stop.limitType === 'model') {
        // The snapshot already said what this is: a workspace wall (credits
        // depleted, workspace cap) that no reset takes down. The banner must
        // not turn it back into a waitable stop — probe, then hold for a
        // human, exactly as parseSnapshot filed it.
        error.limitType = 'model';
        error.resetLine = null;
      } else if (error.limitType === 'unknown'
        // A workspace-wall banner over a spent window: the snapshot already
        // weighed the reason against the window, and the window's reset
        // brings the allowance back. Other model limits keep their label.
        || (error.limitType === 'model' && workspaceWall(stop.reachedType))) {
        error.limitType = stop.limitType;
      }
    }
    hits.push(error);
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

// Model output the rollout records only when a request succeeded. A turn the
// usage limit refuses writes the user message and a task_complete error, never
// one of these.
const MODEL_OUTPUT = new Set(['reasoning', 'function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call']);
function isModelOutput(entry) {
  if (entry?.type !== 'response_item') return false;
  const p = entry.payload || {};
  return (p.type === 'message' && p.role === 'assistant') || MODEL_OUTPUT.has(p.type);
}

// Durable evidence that a Codex session made progress after a recorded stop:
// model output in its rollout, newer than the stop and not followed by a newer
// limit. The Codex counterpart of hasClaudeParentUsageAfter. A banner leaving
// the pane's scan window is not evidence; a keypress, tab switch or overlay
// can do that while the session is still stopped.
export function hasCodexProgressAfter(rec, afterMs, {
  sessionsRoot,
  window = 256 * 1024,
  maxWindow = 4 * 1024 * 1024,
} = {}) {
  if (!rec?.sessionId || !Number.isFinite(afterMs)) return false;
  const path = sessionsRoot ? rolloutPathFor(rec.sessionId, sessionsRoot) : rolloutPathFor(rec.sessionId);
  if (!path) return false;
  let fd;
  try {
    const { size } = statSync(path);
    fd = openSync(path, 'r');
    for (let win = window; ; win = Math.min(win * 2, maxWindow)) {
      const len = Math.min(win, size);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf-8').split('\n');
      if (len < size) lines.shift();   // the first line may be truncated
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        let entry;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        const at = Date.parse(entry?.timestamp);
        if (!Number.isFinite(at)) continue;
        // Lines are chronological: nothing older can postdate the stop.
        if (at <= afterMs) return false;
        // Newest first, so a limit written after the last output means the
        // session stopped again.
        if (parseRolloutLine(lines[i])) return false;
        if (isModelOutput(entry)) return true;
      }
      if (len >= size || win >= maxWindow) return false;
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
