// Hermes Agent adapter (Nous Research, command `hermes`).
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const LIMIT_ANCHORS = [
  /(?:free )?usage limit reached/i,
  /rate limit(?:ed)? (?:exceeded|reached)/i,
  /RateLimitError/i,
  /too many requests/i,
  /resource[_-]exhausted/i,
  /quota (?:limit )?exceeded/i,
  /HTTP 429/i,
  /429 - \{.*RateLimitError/i,
  /error_type=RateLimitError/i,
];

export const patterns = {
  limitPatterns: LIMIT_ANCHORS,
  resetPatterns: [
    /retry (?:after|in)/i,
    /resets? in/i,
    /try again in/i,
    /refreshes in/i,
    /please retry after/i,
    ...LIMIT_ANCHORS,
  ],
  weeklyPatterns: [/weekly (?:usage )?limit/i],
  fiveHourPatterns: [/5.hour (?:usage )?limit/i],
  busyPatterns: [
    /esc to interrupt/i,
    /waiting for response/i,
    /thinking/i,
    /tool call in progress/i,
    /generating/i,
  ],
  idleRegex: /[›❯>]/,
  overloadPatterns: [/503.*(?:overload|capacity)/i, /provider.*overload/i],
  transientPatterns: [/503.*(?:overload|capacity)/i],
  terminalPatterns: [/insufficient credits/i, /out of credits/i, /credit_balance_exhausted/i],
};

export function latestSessionId(cwd) {
  const dbPath = join(process.env.HERMES_HOME || join(homedir(), '.hermes'), 'state.db');
  if (!existsSync(dbPath)) return 'latest';
  try {
    const cleanCwd = (cwd || '').replace(/'/g, "''");
    const out = execFileSync('sqlite3', [
      dbPath,
      `SELECT id FROM sessions WHERE cwd = '${cleanCwd}' ORDER BY COALESCE(last_activity_at, started_at) DESC LIMIT 1;`
    ], { timeout: 3000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const id = out.trim();
    return id || 'latest';
  } catch {
    return 'latest';
  }
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
