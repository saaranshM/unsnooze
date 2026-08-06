// Lookup helpers for Claude Code's transcript store (~/.claude/projects/).
// Used to backfill sessionId when detection came from pane scraping and the
// StopFailure hook didn't supply one, and to estimate a session's context
// size before waking it (contextGuard). Rate-limit banner reads live in
// watchers/claude.js (latestRateLimitFromTranscript).

import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DIR } from './config.js';

// Claude Code maps a cwd to a project dir by replacing every '/' and '.' with '-'.
export function dashCwd(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

export function projectDir(cwd) {
  return join(CLAUDE_DIR, 'projects', dashCwd(cwd));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

// Newest transcript (by mtime) for a cwd = the session most recently active
// there. aroundTs (optional) requires the transcript to have been touched
// within 30 min of the detection time, to avoid grabbing an unrelated session.
export function latestSessionId(cwd, aroundTs = null) {
  let entries;
  try {
    entries = readdirSync(projectDir(cwd));
  } catch {
    return null;
  }
  let best = null;
  for (const name of entries) {
    if (!UUID_RE.test(name)) continue;
    let mtime;
    try { mtime = statSync(join(projectDir(cwd), name)).mtimeMs; } catch { continue; }
    if (aroundTs != null && Math.abs(mtime - aroundTs) > 30 * 60_000) continue;
    if (!best || mtime > best.mtime) best = { id: name.slice(0, -6), mtime };
  }
  return best ? best.id : null;
}

export function transcriptPath(cwd, sessionId, { claudeDir = CLAUDE_DIR } = {}) {
  return join(claudeDir, 'projects', dashCwd(cwd), `${sessionId}.jsonl`);
}

export function claudeRecordEnv(env = process.env) {
  if (!env.CLAUDE_CONFIG_DIR) return null;
  return {
    CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR,
    ...(env.CLAUDE_SECURESTORAGE_CONFIG_DIR != null
      ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: env.CLAUDE_SECURESTORAGE_CONFIG_DIR }
      : {}),
  };
}

export function approxTokens(n) {
  return n >= 1000 ? `~${Math.round(n / 1000)}k` : `~${n}`;
}

// Current context size of a session ≈ the last assistant entry's usage block:
// everything the API read on that turn (fresh + cached) plus what it wrote.
// Tail-read only — transcripts reach tens of MB — doubling the window until a
// usage entry appears or maxWindow is hit. null = unknown (missing file, no
// usage found); callers skip the guard, like workspaceFingerprint's null.
export function lastUsageTokens(path, {
  window = 256 * 1024,
  maxWindow = 4 * 1024 * 1024,
  afterMs = null,
} = {}) {
  let fd;
  try {
    const { size } = statSync(path);
    fd = openSync(path, 'r');
    for (;;) {
      const len = Math.min(window, size);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      let text = buf.toString('utf-8');
      if (len < size) text = text.slice(text.indexOf('\n') + 1);   // drop the partial first line
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.isSidechain === true) continue;   // subagent traffic doesn't ride the main context
        if (afterMs != null && entry.isApiErrorMessage === true && entry.error === 'rate_limit') {
          // The newest main-context outcome is another stop, so an older
          // successful turn cannot prove that the current episode resumed.
          return null;
        }
        if (afterMs != null && (entry.isApiErrorMessage === true
          || entry.type !== 'assistant' || entry.message?.role !== 'assistant')) continue;
        const u = entry.message?.usage;
        if (!u || typeof u !== 'object') continue;
        const sum = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
          + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
        if (sum <= 0) continue;   // zero-sum = synthetic/error entry, keep scanning
        if (afterMs == null) return sum;
        const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
        if (Number.isFinite(at) && at > afterMs) return sum;
        // Lines are chronological. Once the newest timestamped main-context
        // usage is at/before the cutoff, no older entry can prove progress.
        if (Number.isFinite(at)) return null;
      }
      if (len >= size || window >= maxWindow) return null;
      window = Math.min(window * 2, maxWindow);
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Durable evidence that Claude's parent context received a non-error response
// after a recorded stop. Desktop records may live under an isolated
// CLAUDE_CONFIG_DIR rather than the global ~/.claude tree.
export function hasClaudeParentUsageAfter(rec, afterMs) {
  if (!rec?.cwd || !rec?.sessionId || !Number.isFinite(afterMs)) return false;
  const path = transcriptPath(rec.cwd, rec.sessionId, {
    claudeDir: rec.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || CLAUDE_DIR,
  });
  return lastUsageTokens(path, { afterMs }) != null;
}
