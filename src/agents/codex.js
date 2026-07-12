// OpenAI Codex CLI adapter.
//
// Codex has no hook that fires on usage limits (its `notify` config only emits
// agent-turn-complete), so detection is scrape-only. The TUI does NOT exit on
// a hard limit — it renders one red transcript line and sits at the composer:
//   ■ You've hit your usage limit. …{ or try again at 3:51 PM.}
// Reset-time tails vary by plan: "try again at 3:51 PM." (same day),
// "try again at Feb 23rd, 2026 9:01 PM." (cross-day), "Try again in 4 days
// 20 hours 9 minutes." (older builds), or "Try again later." (no timestamp).
// Transient errors render "stream error: … retrying 4/5 in 1.4s" and must take
// the overload path, never the ledger.

import { openSync, readSync, closeSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_DIR } from '../config.js';

// Since the 2026 unified ChatGPT desktop app absorbed the Codex app, the codex
// binary ships INSIDE the app bundle and many machines have no standalone
// `codex` on PATH at all — yet ~/.codex/sessions rollouts (and the resume
// command) work identically through the bundled binary (verified live against
// codex-cli 0.144 from ChatGPT.app).
export const CHATGPT_CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex';

function codexOnPath(env = process.env) {
  return (env.PATH || '').split(':').some(dir => {
    try { return dir && existsSync(join(dir, 'codex')); } catch { return false; }
  });
}

export function resolveCodexBin({ env = process.env, onPath = () => codexOnPath(env), exists = existsSync } = {}) {
  if (env.UNSNOOZE_CODEX_BIN) return env.UNSNOOZE_CODEX_BIN;
  if (onPath()) return 'codex';
  if (exists(CHATGPT_CODEX_BIN)) return CHATGPT_CODEX_BIN;
  return 'codex';   // neither — the launcher degrades gracefully on spawn error
}

const LIMIT_ANCHORS = [
  /You've hit your usage limit/i,
  /Your workspace is out of credits/i,
  /hit your spend cap/i,
];

export const patterns = {
  limitPatterns: LIMIT_ANCHORS,
  // The whole banner is ONE line, so the anchors double as reset lines — the
  // proximity engine then hands that line to time-parser (which falls back to
  // the 5h default for "Try again later.").
  resetPatterns: [
    /try again at/i,
    /try again in \d+/i,
    /try again later/i,
    ...LIMIT_ANCHORS,
  ],
  weeklyPatterns: [/weekly limit/i],
  fiveHourPatterns: [/5h limit/i],
  busyPatterns: [
    /esc to interrupt/i,           // "• Working (12s • esc to interrupt)"
    /retrying\s+\d+\/\d+/i,        // internal stream-error retry — don't inject
  ],
  idleRegex: /›/,                  // composer: "› Ask Codex to do anything"
  overloadPatterns: [/stream error/i, /exceeded retry limit/i],
  transientPatterns: [/stream error/i, /exceeded retry limit/i],
};

// Sessions live in ~/.codex/sessions/YYYY/MM/DD/rollout-{ts}-{UUID}.jsonl;
// the first JSONL line carries the session cwd. Conservative: no cwd match →
// null (the resumer then uses `codex resume --last`, which codex itself scopes
// to the launch cwd).
export const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function fileHead(path, bytes = 4096) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf-8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function latestSessionId(cwd, aroundTs = null, sessionsRoot = join(CODEX_DIR, 'sessions')) {
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) { walk(p, depth + 1); continue; }
      const m = e.isFile() && e.name.match(ROLLOUT_RE);
      if (!m) continue;
      let mtime;
      try { mtime = statSync(p).mtimeMs; } catch { continue; }
      if (aroundTs != null && Math.abs(mtime - aroundTs) > 30 * 60_000) continue;
      files.push({ path: p, id: m[1], mtime });
    }
  };
  walk(sessionsRoot, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  // JSON-escape the cwd the way it appears inside the meta line.
  const needle = cwd ? JSON.stringify(cwd).slice(1, -1) : null;
  for (const f of files.slice(0, 20)) {
    if (!needle || fileHead(f.path).includes(needle)) return f.id;
  }
  return null;
}

export default {
  id: 'codex',
  name: 'OpenAI Codex CLI',
  bin: resolveCodexBin(),
  experimental: false,
  patterns,
  menu: null,                      // no interactive limit menu
  // Resume takes the prompt in argv — `codex resume <id> "msg"` starts the turn
  // immediately, nothing to type into the TUI.
  resumeArgs(sessionId, message) {
    return {
      args: sessionId ? ['resume', sessionId, message] : ['resume', '--last', message],
      messageViaPane: false,
    };
  },
  latestSessionId,
  isForegroundCommand(cmd) {
    return cmd === 'codex' || cmd === 'node' || cmd === 'unsnooze';
  },
};
