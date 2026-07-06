// Lookup helpers for Claude Code's transcript store (~/.claude/projects/).
// Used to backfill sessionId when detection came from pane scraping and the
// StopFailure hook didn't supply one.

import { readdirSync, statSync } from 'node:fs';
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
