// Kimi CLI adapter (MoonshotAI/kimi-cli, command `kimi`) — EXPERIMENTAL.
//
// Limits (researched 2026-07): rolling 5-hour window + weekly quota (7 days
// from subscription date); a concurrency throttle returns the SAME 429. The
// CLI retries 429/5xx three times within seconds, then stops with a red
// "LLM provider error: Error code: 429 - {...rate_limit_reached_error...}"
// line. The 429 body carries NO reset time → 5h fallback + verify loop.
// Known limitation: a weekly limit burns fallback attempts until the resumer
// gives up (a future resetProbe against GET api.kimi.com/coding/v1/usages
// would fix that).
//
// kimi-cli is Python today (pane_current_command may be python3); its
// kimi-code successor is TypeScript (node) with the same `kimi` command and
// auto-migrated ~/.kimi state — both are covered.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const KIMI_DIR = () => process.env.UNSNOOZE_KIMI_DIR || join(homedir(), '.kimi');

const LIMIT_ANCHORS = [
  /rate_limit_reached_error/i,
  /LLM provider error:.*429/i,
  /receiving too many requests at the moment/i,
];

export const patterns = {
  limitPatterns: LIMIT_ANCHORS,
  // The 429 render is one line with no reset text — anchors double as reset
  // lines and time-parser falls back to the 5h default.
  resetPatterns: [...LIMIT_ANCHORS],
  weeklyPatterns: [],
  fiveHourPatterns: [],
  // Fast in-CLI retries ("Retrying after rate limit · attempt 2/3 · 1.2s")
  // resolve within seconds — never inject keys during them.
  busyPatterns: [
    /Retrying after rate limit/i,
    /attempt \d+\/\d+/i,
    /esc to interrupt/i,
  ],
  idleRegex: /[›❯>]/,
  overloadPatterns: [/LLM provider error:.*5\d\d/i, /Retrying after rate limit/i],
  transientPatterns: [/Retrying after rate limit/i],
  // 402: no reset exists — notify-only.
  terminalPatterns: [/Membership expired/i],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sessions live in ~/.kimi/sessions/<md5(cwd)>/<uuid>/.
function sessionsDirFor(cwd, kimiDir) {
  return join(kimiDir, 'sessions', createHash('md5').update(cwd).digest('hex'));
}

function sessionExists(sessionId, kimiDir) {
  let hashes;
  try { hashes = readdirSync(join(kimiDir, 'sessions')); } catch { return false; }
  return hashes.some(h => existsSync(join(kimiDir, 'sessions', h, sessionId)));
}

// ~/.kimi/kimi.json maps each workdir to its last-used session. The exact
// entry shape is undocumented — accept a bare id or any uuid-valued field.
function sessionFromKimiJson(cwd, kimiDir) {
  try {
    const meta = JSON.parse(readFileSync(join(kimiDir, 'kimi.json'), 'utf-8'));
    const entry = meta?.work_dirs?.[cwd];
    if (typeof entry === 'string' && UUID_RE.test(entry)) return entry;
    if (entry && typeof entry === 'object') {
      for (const v of Object.values(entry)) {
        if (typeof v === 'string' && UUID_RE.test(v)) return v;
      }
    }
  } catch { /* missing or unreadable — fall through */ }
  return null;
}

export function latestSessionId(cwd, aroundTs = null, kimiDir = KIMI_DIR()) {
  const fromMeta = sessionFromKimiJson(cwd, kimiDir);
  if (fromMeta) return fromMeta;

  const dir = sessionsDirFor(cwd, kimiDir);
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  let best = null;
  for (const name of entries) {
    if (!UUID_RE.test(name)) continue;
    let mtime;
    try { mtime = statSync(join(dir, name)).mtimeMs; } catch { continue; }
    if (aroundTs != null && Math.abs(mtime - aroundTs) > 30 * 60_000) continue;
    if (!best || mtime > best.mtime) best = { id: name, mtime };
  }
  return best ? best.id : null;
}

export default {
  id: 'kimi',
  name: 'Kimi CLI',
  bin: process.env.UNSNOOZE_KIMI_BIN || 'kimi',
  experimental: true,
  patterns,
  menu: null,
  // `kimi -r <id> -p "<msg>"` carries the prompt in argv. Guard: a missing id
  // makes kimi silently create a NEW session, so verify it exists on disk and
  // otherwise use --continue (kimi scopes that to the cwd itself).
  resumeArgs(sessionId, message) {
    const valid = sessionId && sessionExists(sessionId, KIMI_DIR());
    return {
      args: valid ? ['-r', sessionId, '-p', message] : ['--continue', '-p', message],
      messageViaPane: false,
    };
  },
  latestSessionId,
  isForegroundCommand(cmd) {
    // /i: macOS framework builds report "Python" (verified via tmux
    // pane_current_command against the real pipx install).
    return cmd === 'kimi' || cmd === 'node' || cmd === 'unsnooze' || /^python(\d(\.\d+)?)?$/i.test(cmd);
  },
};
