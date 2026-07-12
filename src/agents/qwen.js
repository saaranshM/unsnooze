// Qwen Code CLI adapter (QwenLM/qwen-code, command `qwen`) — EXPERIMENTAL.
//
// Limits landscape (researched 2026-07): the Qwen OAuth free tier was
// discontinued 2026-04-15 (that message is terminal, not a limit). The paid
// path is the Alibaba Coding Plan — a rolling 5-hour window + weekly quota
// whose exhaustion 429 (`Throttling.AllocationQuota`) is fail-fast: the CLI
// stops. Error strings below are verbatim from the qwen-code source
// (packages/core/src/utils/{retry,errorParsing}.ts). No reset time is ever
// shown or written to disk → detection leans on the 5h fallback + the
// verify/self-correct loop.
//
// Qwen also supports Claude-shaped JSON hooks in ~/.qwen/settings.json with a
// StopFailure event (matcher matches the error class: rate_limit | ... );
// install.js merges ours in when the agent is enabled.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const QWEN_DIR = () => process.env.UNSNOOZE_QWEN_DIR || join(homedir(), '.qwen');

const LIMIT_ANCHORS = [
  /Qwen (?:OAuth|API) quota exceeded/i,        // legacy free-tier / API-quota renders
  /Allocated quota exceeded/i,                 // Coding Plan + "Free allocated quota exceeded"
  /\[API Error:.*(?:429|rate limit)/i,         // OpenAI-compat providers incl. OpenRouter
  /Possible quota limitations in place/i,      // qwen's own 429 suffix line
  /Rate limit exceeded: limit_/i,              // OpenRouter limit_rpd/limit_rpm bodies
];

export const patterns = {
  limitPatterns: LIMIT_ANCHORS,
  // No reset text exists in any qwen limit render — anchors double as reset
  // lines (codex/grok trick) and time-parser falls back to the 5h default.
  resetPatterns: [...LIMIT_ANCHORS],
  weeklyPatterns: [],
  fiveHourPatterns: [/Allocated quota exceeded/i],   // Coding Plan window is rolling 5h
  // Transient throttles self-retry with a countdown — never inject keys then.
  busyPatterns: [
    /Retrying in \d+s/i,          // "↻ Retrying in 5s… (attempt 2/5)"
    /attempt \d+\/\d+/i,
    /esc to cancel/i,
  ],
  idleRegex: /[›❯>]/,
  overloadPatterns: [/\[API Error:.*5\d\d/i, /Retrying in \d+s/i],
  transientPatterns: [/Retrying in \d+s/i],
  // Non-resetting stops: notify-only, never the ledger.
  terminalPatterns: [/free tier has been discontinued/i, /insufficient credits/i],
};

// qwen-code maps a cwd to a project dir by replacing every non-alphanumeric
// char with '-' (packages/core/src/utils/paths.ts sanitizeCwd) — close to but
// not identical with claude's scheme (which keeps '_').
export function sanitizeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const RUNTIME_RE = /\.runtime\.json$/;
const CHAT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

// v0.16+ writes a <sessionId>.runtime.json sidecar ({pid, session_id,
// work_dir, started_at}) next to each chat, purpose-built for observability
// daemons. Prefer it; fall back to the newest chat transcript by mtime.
export function latestSessionId(cwd, aroundTs = null, qwenDir = QWEN_DIR()) {
  const chatsDir = join(qwenDir, 'projects', sanitizeCwd(cwd), 'chats');
  let entries;
  try { entries = readdirSync(chatsDir); } catch { return null; }

  let best = null;
  for (const name of entries) {
    if (!RUNTIME_RE.test(name)) continue;
    try {
      const meta = JSON.parse(readFileSync(join(chatsDir, name), 'utf-8'));
      if (meta.work_dir !== cwd || !meta.session_id) continue;
      if (!best || (meta.started_at || 0) > best.startedAt) {
        best = { id: meta.session_id, startedAt: meta.started_at || 0 };
      }
    } catch { /* unreadable sidecar — skip */ }
  }
  if (best) return best.id;

  let newest = null;
  for (const name of entries) {
    if (!CHAT_RE.test(name)) continue;
    let mtime;
    try { mtime = statSync(join(chatsDir, name)).mtimeMs; } catch { continue; }
    if (aroundTs != null && Math.abs(mtime - aroundTs) > 30 * 60_000) continue;
    if (!newest || mtime > newest.mtime) newest = { id: name.slice(0, -6), mtime };
  }
  return newest ? newest.id : null;
}

export default {
  id: 'qwen',
  name: 'Qwen Code',
  bin: process.env.UNSNOOZE_QWEN_BIN || 'qwen',
  experimental: true,
  patterns,
  menu: null,
  // `qwen --resume <id>` reopens the TUI; there is no verified
  // resume-with-prompt argv form, so the message is typed once idle.
  resumeArgs(sessionId) {
    return { args: sessionId ? ['--resume', sessionId] : ['--continue'], messageViaPane: true };
  },
  latestSessionId,
  isForegroundCommand(cmd) {
    return cmd === 'qwen' || cmd === 'node' || cmd === 'unsnooze';
  },
};
