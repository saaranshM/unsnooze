// Lookup helpers for Claude Code's transcript store (~/.claude/projects/).
// Used to backfill sessionId when detection came from pane scraping and the
// StopFailure hook didn't supply one, and to estimate a session's context
// size before waking it (contextGuard).

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

export function transcriptPath(cwd, sessionId) {
  return join(projectDir(cwd), `${sessionId}.jsonl`);
}

export function approxTokens(n) {
  return n >= 1000 ? `~${Math.round(n / 1000)}k` : `~${n}`;
}

// Current context size of a session ≈ the last assistant entry's usage block:
// everything the API read on that turn (fresh + cached) plus what it wrote.
// Tail-read only — transcripts reach tens of MB — doubling the window until a
// usage entry appears or maxWindow is hit. null = unknown (missing file, no
// usage found); callers skip the guard, like workspaceFingerprint's null.
export function lastUsageTokens(path, { window = 256 * 1024, maxWindow = 4 * 1024 * 1024 } = {}) {
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
        const u = entry.message?.usage;
        if (!u || typeof u !== 'object') continue;
        const sum = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
          + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
        if (sum > 0) return sum;   // zero-sum = synthetic/error entry, keep scanning
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
