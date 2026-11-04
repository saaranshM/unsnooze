// Hermes Agent adapter (Nous Research, command `hermes`) — EXPERIMENTAL.
//
// Hermes is Python-based with both a prompt_toolkit CLI and an Ink-based TUI
// (display.interface: tui).
//
// Limits: Providers return standard 429 / rate_limit errors. When an API call
// fails, Hermes performs internal retries ("API call failed (attempt 1/3) ...",
// "⚠️  Attempt 1/3 failed: ...") before stopping.
// When retries are exhausted, Hermes renders:
//   - Diagnostic status: "❌ Rate limited after 3 retries — <summary> (resets in <window>)"
//   - Turn error summary: "API call failed after 3 retries: <summary>"
//   - Chat explanation: "<provider> rate-limited every one of 3 attempts — its usage limit resets in <window>."
//   - Or reset line: "Limit resets at HH:MM (in <window>)."
//   - Plan / daily limits: "You've hit your daily limit · resets HH:MM · /topup to add credits"
//
// Transient retries ("attempt 1/3") must be treated as busy/transient, NOT as
// limit stops, so unsnooze never types into an active retry loop.
// Limit anchors are strictly anchored to Hermes's own error lines so bare
// 429 / RateLimitError in tool execution (e.g. `curl`) is never misdetected.
//
// Sessions: Hermes stores session history in SQLite at $HERMES_HOME/state.db
// (default ~/.hermes/state.db). The `sessions` table tracks `cwd`, `started_at`,
// and `last_activity_at`. Resumption uses `hermes --resume <session_id>` or
// `hermes --resume latest`.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  // node:sqlite is built-in on Node >= 22.5; fallback handles older runtimes
}

const HERMES_DIR = () => process.env.HERMES_HOME || join(homedir(), '.hermes');

const LIMIT_ANCHORS = [
  /❌\s*Rate limited after \d+ (?:retries|attempt)/i,
  /API call failed after \d+ retries:.*(?:429|rate[ _-]?limit|quota|resource[ _-]?exhausted|too many requests)/i,
  /rate-limited every one of \d+ attempts/i,
  /is rate-limiting requests right now/i,
  /its usage limit resets in/i,
  /Limit resets at \d{1,2}:\d{2}/i,
  /You['’]ve hit your daily limit/i,
];

export const patterns = {
  limitPatterns: LIMIT_ANCHORS,
  resetPatterns: [
    /its usage limit resets in\s+\d+/i,
    /Limit resets at \d{1,2}:\d{2}\s+\(in\s+[^)]+\)/i,
    /resets?\s+in\s+\d+/i,
    /resets?\s+\d{1,2}:\d{2}/i,
    /retry (?:after|in)\s+\d+/i,
    /please retry after\s+\d+/i,
    /try again in\s+\d+/i,
    /❌\s*Rate limited after \d+ (?:retries|attempt).*\(resets in [^)]+\)/i,
    /You['’]ve hit your daily limit\s*·\s*resets\s+\d{1,2}:\d{2}/i,
    ...LIMIT_ANCHORS,
  ],
  weeklyPatterns: [/weekly (?:usage )?limit/i],
  fiveHourPatterns: [/5.hour (?:usage )?limit/i],
  busyPatterns: [
    /(?:ctrl\+c|esc) (?:again )?(?:to )?interrupt/i,
    /⚡\s*Interrupting/i,
    /interrupting…/i,
    /running…/i,
    /summoning hermes…/i,
    /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
    /attempt \d+\/\d+/i,
    /API call failed \(attempt \d+\/\d+\)/i,
    /⚠️\s*Attempt \d+\/\d+ failed/i,
  ],
  idleRegex: /[›❯>]/,
  overloadPatterns: [
    /503.*(?:overload|capacity|service unavailable)/i,
    /reported it was overloaded on all \d+ attempts/i,
    /❌\s*API failed after \d+ retries.*503/i,
    /attempt \d+\/\d+/i,
  ],
  transientPatterns: [
    /attempt \d+\/\d+/i,
    /API call failed \(attempt \d+\/\d+\)/i,
    /⚠️\s*Attempt \d+\/\d+ failed/i,
    /503.*(?:overload|capacity|service unavailable)/i,
    /reported it was overloaded on all \d+ attempts/i,
  ],
  terminalPatterns: [
    /Billing or credits exhausted/i,
    /Provider reported usage\/credit exhaustion/i,
    /insufficient credits/i,
    /out of credits/i,
    /credit_balance_exhausted/i,
  ],
};

export function latestSessionId(cwd, aroundTs = null, hermesDir = null) {
  const root = hermesDir || HERMES_DIR();
  const dbPath = join(root, 'state.db');
  if (!existsSync(dbPath)) return 'latest';

  const query = 'SELECT id FROM sessions WHERE cwd = ? ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1;';

  // Strategy 1: node:sqlite (zero external process, parameterized, Node >= 22.5)
  if (DatabaseSync) {
    try {
      const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
      try {
        const row = db.prepare(query).get(cwd || '');
        if (row && typeof row === 'object' && row.id) {
          return row.id;
        }
      } finally {
        db.close();
      }
    } catch {
      // Fall through to CLI / python fallback
    }
  }

  // Strategy 2: sqlite3 CLI
  try {
    const cleanCwd = (cwd || '').replace(/'/g, "''");
    const out = execFileSync('sqlite3', [
      dbPath,
      `SELECT id FROM sessions WHERE cwd = '${cleanCwd}' ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1;`
    ], { timeout: 3000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const id = out.trim();
    if (id) return id;
  } catch {
    // sqlite3 not installed
  }

  // Strategy 3: python3 / python (Hermes is a Python package, so Python with sqlite3 is always available)
  for (const py of ['python3', 'python']) {
    try {
      const script = 'import sqlite3, sys; conn = sqlite3.connect(sys.argv[1]); c = conn.cursor(); c.execute("SELECT id FROM sessions WHERE cwd = ? ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1", (sys.argv[2],)); row = c.fetchone(); print(row[0] if row else "")';
      const out = execFileSync(py, [
        '-c', script, dbPath, cwd || ''
      ], { timeout: 3000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const id = out.trim();
      if (id) return id;
      break;
    } catch {
      // try next
    }
  }

  return 'latest';
}

export default {
  id: 'hermes',
  name: 'Hermes Agent (Nous Research)',
  bin: process.env.UNSNOOZE_HERMES_BIN || 'hermes',
  experimental: true,
  patterns,
  menu: null,
  resumeArgs(sessionId) {
    return {
      args: sessionId && sessionId !== 'latest' ? ['--resume', sessionId] : ['--resume', 'latest'],
      messageViaPane: true,
    };
  },
  launchArgs(message) { return { args: [], messageViaPane: true }; },
  latestSessionId,
  isForegroundCommand(cmd) {
    return /^hermes(\.exe)?$/.test(cmd) || cmd === 'node' || cmd === 'unsnooze' || cmd === 'python' || cmd === 'python3';
  },
};
