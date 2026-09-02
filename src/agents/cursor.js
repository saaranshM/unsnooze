// Cursor CLI adapter (`cursor-agent`) — EXPERIMENTAL.
//
// Cursor ships its terminal agent as ~/.local/bin/{agent,cursor-agent}, both
// symlinks to ~/.local/share/cursor-agent/versions/<v>/cursor-agent. That file
// is a bash shim that runs `exec -a "$0" <bundled node> index.js`, so the
// binary is Node and tmux reports `node` as pane_current_command (verified on
// darwin/arm64, 2026.08.31-4057e58).
//
// The id is `cursor` but the wrapped command is `cursor-agent` (see
// `wrapperNames` below): the bare `cursor` is the IDE launcher (`cursor .`)
// and must never be shadowed. The other name, `agent`, is deliberately NOT
// wrapped — too generic to shadow safely.
//
// WHY resetPatterns IS EMPTY — do not "fix" this.
// Cursor's included usage resets on the monthly BILLING CYCLE ("Your usage
// limits will reset when your monthly cycle ends on 8/14/2025"), not on a
// rolling window. detectLimit() runs the waitable-limit loop before the
// model-limit branch, so a reset pattern here would pair with the banner and
// produce a `limitType: 'unknown'` record whose unparseable date falls back to
// 5h — i.e. a blind resume into a wall that is still standing. An empty
// resetPatterns routes the banner down the model-limit path instead, which
// probes until the banner clears and never schedules a blind wake. There is a
// test pinning this.
//
// Banner provenance: the limit text is SERVER-provided. The CLI bundle
// contains no limit strings — it renders `Error: ${details.title}`, then
// `details.detail`, then one `key: value` line per `details.additionalInfo`
// entry, with persistUntilInput so the banner stays on screen. CAPTURED FROM A
// REAL LIMIT (free plan, 2026-09-02):
//
//   Error: You've hit your usage limit
//   Get Cursor Pro for more Agent usage, unlimited Tab, and more.
//   fallbackModel:
//   spendLimitHit: false
//   chatMessage: *You've hit your free requests limit. [Upgrade to
//   Pro](https://www.cursor.com/...) for more usage, frontier models, Cloud
//   Agents, and more. Your usage limits will reset when your monthly cycle
//   ends on 10/2/2026.*
//   spendLimits: [50,100,200]
//
// Note the reset is a MONTH out — exactly why this is not a waitable stop. A
// `-p` run prints the same thing to stderr with the error class as the prefix
// (`ActionRequiredError: ...`) and exits 1. Pro-plan wording differs ("Switch
// to Auto…", "set a Spend Limit") and is covered from user reports; improve
// the rest from real hits with `unsnooze report cursor`.
//
// Verified live against 2026.08.31-4057e58 (logged in, real tmux):
//   idle      ` → Plan, search, build anything` / ` → Add a follow-up`
//   busy      `⠘⠤ Working` (braille spinner + label) and the input box's
//             right placeholder `ctrl+c to stop`
//   resume    `--continue` is WORKSPACE-scoped — run from project A it resumed
//             A's chat, not the globally-newest one in B. That is what the
//             resumer's one-anonymous-record-per-agent+cwd rule assumes, so no
//             --workspace flag is needed.
//   submit    the wake message lands with tmux's `send-keys -l` + a separate
//             `send-keys Enter`, which is exactly what mux.sendText already does.
//
// A first launch in an untrusted directory shows a modal "⚠ Workspace Trust
// Required" screen instead of the prompt. It carries no `→`, so idleRegex
// already refuses to type into it; busyPatterns names it as well so the refusal
// does not depend on that. unsnooze deliberately does NOT pass `--trust` on
// revival — granting execution trust is the user's call, not a side effect of
// waking a session.
//
// Deferred: Cursor writes a status into the TERMINAL TITLE (idle/generating/
// planning/shell-running/waiting-for-user...), which is a far cleaner
// busy/idle signal than scraping — but the adapter contract only sees
// capture-pane text. See the adapter notes in the changelog.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CURSOR_DIR = () => process.env.UNSNOOZE_CURSOR_DIR || join(homedir(), '.cursor');
const SCAN_LIMIT = 50;   // project dirs walked by the fallback scan

const LIMIT_ANCHORS = [
  /You[’']ve hit your (?:usage|free requests?|monthly) limit/i,
  /You[’']ve hit your limit/i,
  /(?:usage|spend) limit reached/i,
];

export const patterns = {
  limitPatterns: LIMIT_ANCHORS,
  resetPatterns: [],          // deliberate — see the header
  weeklyPatterns: [],
  fiveHourPatterns: [],
  // The monthly cap is lifted by a human choice (switch to Auto, enable
  // on-demand, wait for the billing date), never by a short wait — the same
  // shape as claude's per-model limit, so it takes the same path.
  modelLimitPatterns: LIMIT_ANCHORS,
  // The detail line is plan-dependent — a free account is told to upgrade, a Pro
  // account to switch models or raise a spend limit — so cover both rather than
  // leaning on the additionalInfo keys alone, which Cursor could drop.
  modelRemedyPatterns: [
    /Get Cursor Pro for more Agent usage/i,        // free tier (captured live)
    /\[?Upgrade to\s+Pro\]?/i,
    /Switch to Auto for more usage/i,              // Pro tier (reported)
    /set a Spend Limit/i,
    /usage limits will reset when your monthly cycle ends/i,
    /enable (?:on-demand|usage-based)/i,
    // additionalInfo entries render as bare `key: value` lines under the detail.
    /^\s*(?:spendLimitHit|fallbackModel|spendLimits|chatMessage):/,
  ],
  busyPatterns: [
    /ctrl\+c to stop/i,                          // input box's right placeholder while generating
    /[\u2800-\u28ff]\s*(?:Working|Composing)\b/,  // braille spinner + label, e.g. `⠘⠤ Working`
    // Not "busy" in the streaming sense, but equally un-typeable: the modal
    // trust gate on a first launch in a directory.
    /Workspace Trust Required/i,
    /Do you trust the contents of this directory/i,
  ],
  idleRegex: /→/,           // the input box prompt glyph
  overloadPatterns: [
    /Can[’']t (?:resolve the Cursor API host|reach the Cursor API)/i,
    /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|NGHTTP2|ERR_HTTP2_SESSION_ERROR)\b/,
    /socket hang up|Premature close|connection aborted/i,
    /Agent stopped retrying/i,
  ],
  transientPatterns: [
    /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/,
  ],
  // Auth is not a quota — notify once and record nothing. `-p` runs print the
  // error class instead of the `Error:` prefix the TUI uses, so match the text
  // rather than either prefix.
  terminalPatterns: [
    /Authentication required\b/i,
    /Please run '(?:cursor-)?agent login'/i,
  ],
};

// Cursor stores each CLI chat as ~/.cursor/chats/<md5(cwd)>/<chatId>/, where
// <chatId> is the directory name and is exactly what `--resume=<id>` takes
// (verified live). Its meta.json carries `{ cwd, updatedAtMs, title }`, so the
// mapping needs no SQLite and no dependency — and every candidate is checked
// against the cwd before it is used. If Cursor ever changes the hash, the
// bounded fallback scan below still finds it; if it changes meta.json too,
// this returns null and the resumer falls back to `--continue`, which is
// workspace-scoped anyway. A wrong id would resume someone else's
// conversation, so null is always preferred to a guess.
//
// aroundTs is accepted and ignored (as in agy): the chat that just stopped is
// the most recently updated one for the cwd, which is what we return.
function readChatMeta(chatDir) {
  try {
    const meta = JSON.parse(readFileSync(join(chatDir, 'meta.json'), 'utf-8'));
    if (!meta || typeof meta.cwd !== 'string') return null;
    return { cwd: meta.cwd, updatedAtMs: Number(meta.updatedAtMs) || 0 };
  } catch {
    return null;
  }
}

// Newest chat under `dir` whose meta.json cwd equals `cwd`.
function newestChatIn(dir, cwd) {
  let best = null;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = readChatMeta(join(dir, entry.name));
    if (!meta || meta.cwd !== cwd) continue;
    if (!best || meta.updatedAtMs > best.updatedAtMs) best = { id: entry.name, updatedAtMs: meta.updatedAtMs };
  }
  return best;
}

export function latestSessionId(cwd, aroundTs = null, cursorDir = CURSOR_DIR()) {
  if (!cwd) return null;
  const chats = join(cursorDir, 'chats');
  // Fast path: the project directory is md5 of the cwd (verified live).
  const direct = newestChatIn(join(chats, createHash('md5').update(cwd).digest('hex')), cwd);
  if (direct) return direct.id;
  // Fallback: the hash scheme changed. Scan the most recently touched project
  // directories only — bounded so a long-lived install never walks hundreds.
  let projects;
  try {
    projects = readdirSync(chats, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const full = join(chats, e.name);
        let mtimeMs = 0;
        try { mtimeMs = statSync(full).mtimeMs; } catch { /* skip */ }
        return { full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, SCAN_LIMIT);
  } catch {
    return null;
  }
  let best = null;
  for (const project of projects) {
    const found = newestChatIn(project.full, cwd);
    if (found && (!best || found.updatedAtMs > best.updatedAtMs)) best = found;
  }
  return best ? best.id : null;
}

export default {
  id: 'cursor',
  name: 'Cursor CLI',
  bin: process.env.UNSNOOZE_CURSOR_BIN || 'cursor-agent',
  // `cursor` is the IDE launcher — wrap the agent command only.
  wrapperNames: ['cursor-agent'],
  experimental: true,
  patterns,
  // Cursor has /model, but no /usage-credits — on-demand usage is a dashboard
  // setting. Telling a Cursor user to run a command that does not exist is
  // worse than saying nothing.
  modelRemedy: 'switch to Auto (/model) or enable on-demand usage in your Cursor dashboard',
  menu: null,
  // `--resume [chatId]` and `--continue` both verified in `cursor-agent --help`
  // (2026.08.31). --resume takes an optional value, so use the equals form.
  resumeArgs(sessionId) {
    return { args: sessionId ? [`--resume=${sessionId}`] : ['--continue'], messageViaPane: true };
  },
  // v1: every agent launches the bare TUI and gets the prompt typed once idle.
  launchArgs(message) { return { args: [], messageViaPane: true }; },
  latestSessionId,
  // The bash shim execs the bundled node, so tmux reports `node`.
  isForegroundCommand(cmd) {
    return cmd === 'cursor-agent' || cmd === 'agent' || cmd === 'node' || cmd === 'unsnooze';
  },
};
