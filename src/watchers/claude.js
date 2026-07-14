// Claude Code transcript watcher: parses lines appended to session transcript
// files (~/.claude/projects/<dashed-cwd>/<session-id>.jsonl) into limit-stop
// candidates. This is the detection channel for GUI surfaces (VS Code
// extension, desktop app) where no tmux pane exists and hooks may not fire —
// a rate-limit stop lands in the transcript as a structured API-error entry:
//   { "error":"rate_limit", "isApiErrorMessage":true, "apiErrorStatus":429,
//     "entrypoint":"cli", "cwd":..., "sessionId":...,
//     "message":{"content":[{"type":"text","text":"You've hit your session
//       limit · resets 6:40pm (Asia/Calcutta)"}]} }

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { detectLimit } from '../patterns.js';
import { patterns } from '../agents/claude.js';
import { PANE_SCAN_LINES, WATCH_FRESHNESS_MS } from '../config.js';
import { transcriptPath } from '../sessions.js';

// One transcript JSONL line → limit-stop candidate or null. Sidechain
// (subagent) entries are skipped — the resume target is the parent session,
// whose own entry carries the same error.
export function parseTranscriptLine(line) {
  if (!line || !line.trim()) return null;
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  if (!entry || entry.isApiErrorMessage !== true) return null;
  if (entry.error !== 'rate_limit') return null;
  if (entry.isSidechain) return null;

  const content = entry.message?.content;
  const text = (Array.isArray(content) && content.find(c => c?.type === 'text')?.text) || '';
  const d = detectLimit(text, PANE_SCAN_LINES, patterns);
  const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;

  return {
    sessionId: entry.sessionId || null,
    cwd: entry.cwd || null,
    entrypoint: entry.entrypoint || null,
    limitType: d.hit ? d.limitType : 'unknown',
    resetLine: d.hit ? d.resetLine : null,
    timestampMs: Number.isFinite(ts) ? ts : null,
  };
}

// Newest rate_limit / isApiErrorMessage entry in a session transcript.
// Yields both the banner text and its true timestamp — the authoritative
// channel for Claude limit stops (hook/monitor prefer this over pane scrape).
// null when the file is missing, empty, or has no fresh rate-limit entry.
export function latestRateLimitFromTranscript(cwd, sessionId, {
  maxAgeMs = WATCH_FRESHNESS_MS,
  now = Date.now(),
  window = 256 * 1024,
  maxWindow = 4 * 1024 * 1024,
} = {}) {
  if (!cwd || !sessionId) return null;
  const path = transcriptPath(cwd, sessionId);
  let fd;
  try {
    const { size } = statSync(path);
    fd = openSync(path, 'r');
    for (;;) {
      const len = Math.min(window, size);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      let text = buf.toString('utf-8');
      if (len < size) text = text.slice(text.indexOf('\n') + 1);
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const c = parseTranscriptLine(lines[i]);
        if (!c) continue;
        if (c.timestampMs != null && maxAgeMs != null && now - c.timestampMs > maxAgeMs) {
          return null;   // newest match is too old — nothing fresh
        }
        return c;
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
