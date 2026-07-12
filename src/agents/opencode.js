// OpenCode adapter (sst/opencode, command `opencode`) — EXPERIMENTAL.
//
// OpenCode is unusual: it self-retries rate limits FOREVER, honoring
// retry-after headers (it will happily sleep 3 hours until a reset), showing a
// status line like "Rate Limited [retrying in 2h5m attempt #4]". The session
// only stops on non-retryable errors (402 credits, auth, context overflow) or
// user abort. So the retry banner is BOTH a limit anchor and a busy pattern:
//   - a LIVE self-retrying pane records a stop but is busy → the resumer
//     defers, and the monitor flips the record to 'resumed' when the banner
//     clears (OpenCode recovered on its own)
//   - a DEAD pane mid-wait (laptop slept, tmux killed) is revived at the reset
//     via `opencode -s <ses_id>`
// Banner strings are verbatim from packages/opencode/src/session/retry.ts and
// the console zen i18n; the bracketed countdown parses via time-parser's
// Go-duration support.

import { execFileSync } from 'node:child_process';

const LIMIT_ANCHORS = [
  /(?:5.hour|weekly|monthly) usage limit reached/i,   // Zen Go plans
  /usage limit reached/i,
  /Free usage exceeded/i,                              // Zen free tier
  /Subscription quota exceeded/i,                      // Zen Black
  /Rate Limited \[retrying/i,                          // status-line retry banner
  /Too Many Requests \[retrying/i,
  /Rate limit exceeded: limit_/i,                      // OpenRouter limit_rpd/limit_rpm
  /free models per day/i,                              // OpenRouter free-tier daily
];

const RETRY_BANNER = /\[retrying(?: in [^\]]+)? attempt #\d+\]/i;

export const patterns = {
  limitPatterns: LIMIT_ANCHORS,
  resetPatterns: [
    /It will reset in/i,
    /Resets? in/i,
    /Retry in/i,
    /\[retrying in/i,
    ...LIMIT_ANCHORS,
  ],
  weeklyPatterns: [/weekly usage limit/i],
  fiveHourPatterns: [/5.hour usage limit/i],
  busyPatterns: [
    RETRY_BANNER,                 // self-retrying — OpenCode is handling it
    /esc (?:again to )?interrupt/i,
  ],
  idleRegex: /[›❯>]/,
  overloadPatterns: [/Provider is overloaded/i],
  transientPatterns: [/Provider is overloaded \[retrying/i],
  // Non-retryable, non-resetting stops: notify-only.
  terminalPatterns: [/insufficient credits/i, /out of credits/i],
};

function runSessionList() {
  return execFileSync(process.env.UNSNOOZE_OPENCODE_BIN || 'opencode',
    ['session', 'list', '--format', 'json'],
    { timeout: 5000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// `opencode session list --format json` — sessions live in a SQLite db, so ask
// the CLI rather than parsing it. Output tolerated as a JSON array or JSONL.
export function latestSessionId(cwd, aroundTs = null, runner = runSessionList) {
  let raw;
  try { raw = runner(); } catch { return null; }
  let sessions = [];
  try {
    const parsed = JSON.parse(raw);
    sessions = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    for (const line of String(raw).split('\n')) {
      if (!line.trim()) continue;
      try { sessions.push(JSON.parse(line)); } catch { /* skip noise lines */ }
    }
  }
  let best = null;
  for (const s of sessions) {
    if (!s || typeof s !== 'object') continue;
    const dir = s.directory ?? s.dir ?? s.cwd;
    const id = s.id ?? s.sessionID ?? s.session_id;
    if (dir !== cwd || !id) continue;
    const updated = s.time_updated ?? s.time?.updated ?? 0;
    if (!best || updated > best.updated) best = { id, updated };
  }
  return best ? best.id : null;
}

export default {
  id: 'opencode',
  name: 'OpenCode',
  bin: process.env.UNSNOOZE_OPENCODE_BIN || 'opencode',
  experimental: true,
  patterns,
  menu: null,
  // `opencode -s <id>` reopens the TUI on that session; the resume message is
  // typed once idle. (`opencode run -s <id> "msg"` exists but is headless-only.)
  resumeArgs(sessionId) {
    return { args: sessionId ? ['-s', sessionId] : ['--continue'], messageViaPane: true };
  },
  latestSessionId,
  isForegroundCommand(cmd) {
    // The npm-shipped bun binary reports pane_current_command "opencode.exe"
    // even on macOS (verified live).
    return /^opencode(\.exe)?$/.test(cmd) || cmd === 'node' || cmd === 'unsnooze';
  },
};
