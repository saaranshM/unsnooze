// Claude Code transcript watcher: parses lines appended to session transcript
// files (~/.claude/projects/<dashed-cwd>/<session-id>.jsonl) into limit-stop
// candidates. This is the detection channel for GUI surfaces (VS Code
// extension, desktop app) where no tmux pane exists and hooks may not fire —
// a rate-limit stop lands in the transcript as a structured API-error entry:
//   { "error":"rate_limit", "isApiErrorMessage":true, "apiErrorStatus":429,
//     "entrypoint":"cli", "cwd":..., "sessionId":...,
//     "message":{"content":[{"type":"text","text":"You've hit your session
//       limit · resets 6:40pm (Asia/Calcutta)"}]} }

import { detectLimit } from '../patterns.js';
import { patterns } from '../agents/claude.js';
import { PANE_SCAN_LINES } from '../config.js';

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
