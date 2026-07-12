// Google Antigravity CLI adapter (`agy`) — EXPERIMENTAL.
//
// agy is the closed-source Go successor to Gemini CLI (which stopped serving
// individual accounts 2026-06-18). Limits: rolling ~5h "sprint" window plus a
// weekly cap, metered per model. The banner strings here come from Google
// forum reports, not source ("Model quota limit exceeded", "Refreshes in
// 6 days and 18 hours") — grok-bar experimental; improve via `unsnooze report`.
//
// 503 MODEL_CAPACITY_EXHAUSTED is provider capacity (transient), NOT a user
// quota — it takes the overload path.
//
// Deferred by design: the hooks.json channel (schema drifted between builds)
// and the loopback RetrieveUserQuotaSummary endpoint (authoritative per-meter
// resetTime) — the latter is the natural future resetProbe seam.

import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AGY_DIR = () => process.env.UNSNOOZE_AGY_DIR || join(homedir(), '.gemini', 'antigravity-cli');

const LIMIT_ANCHORS = [
  /Model quota limit exceeded/i,
  /RESOURCE_EXHAUSTED/,
  /quota (?:limit )?exceeded/i,
];

export const patterns = {
  limitPatterns: LIMIT_ANCHORS,
  // "Refreshes in 6 days and 18 hours" renders near the quota banner; anchors
  // double as reset lines for the API-key single-line renders.
  resetPatterns: [
    /Refreshes in/i,
    ...LIMIT_ANCHORS,
  ],
  weeklyPatterns: [/Refreshes in \d+ days?/i],   // multi-day refresh = the weekly cap
  fiveHourPatterns: [],
  busyPatterns: [
    /esc to interrupt/i,
    /attempt \d+\/\d+/i,
  ],
  idleRegex: /[›❯>]/,
  overloadPatterns: [/MODEL_CAPACITY_EXHAUSTED/i, /503.*(?:capacity|exhausted)/i],
  transientPatterns: [/MODEL_CAPACITY_EXHAUSTED/i],
  terminalPatterns: [/not logged into Antigravity/i],   // auth, not quota — notify only
};

// ~/.gemini/antigravity-cli/history.jsonl indexes all conversations. Schema is
// undocumented (and a SQLite migration is rumored) — parse the tail
// tolerantly: an entry counts if any string value equals the cwd, its id is
// the first conversation-ish field. Null on any doubt (the resumer then opens
// a fresh agy session; the wake message explains the context loss).
function tailBytes(path, bytes = 64 * 1024) {
  let fd;
  try {
    const size = statSync(path).size;
    fd = openSync(path, 'r');
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    const n = readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf-8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function latestSessionId(cwd, aroundTs = null, agyDir = AGY_DIR()) {
  const text = tailBytes(join(agyDir, 'history.jsonl'));
  if (!text) return null;
  const lines = text.split('\n').filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (!entry || typeof entry !== 'object') continue;
    if (!Object.values(entry).some(v => v === cwd)) continue;
    const id = entry.conversation_id ?? entry.conversationId ?? entry.id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

export default {
  id: 'agy',
  name: 'Antigravity CLI (Google)',
  bin: process.env.UNSNOOZE_AGY_BIN || 'agy',
  experimental: true,
  patterns,
  menu: null,
  // `agy --conversation=<id>` resumes (printed by agy itself on exit);
  // `--continue` reopens the most recent conversation (verified in agy --help).
  resumeArgs(sessionId) {
    return { args: sessionId ? [`--conversation=${sessionId}`] : ['--continue'], messageViaPane: true };
  },
  latestSessionId,
  isForegroundCommand(cmd) {
    return cmd === 'agy' || cmd === 'node' || cmd === 'unsnooze';
  },
};
