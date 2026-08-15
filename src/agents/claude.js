// Claude Code adapter: everything unsnooze needs to know about one CLI lives
// in its adapter — banner regexes, busy/idle markers, resume invocation,
// session-id lookup, and (claude-only) the interactive limit-menu driver.

import { contentLines } from '../patterns.js';
import { latestSessionId, transcriptPath, lastUsageTokens } from '../sessions.js';

export const patterns = {
  // Claude Code renders limits across multiple TUI lines, e.g.:
  //   "⚠ You've hit your 5-hour limit"
  //   "· resets 3pm (UTC)"
  limitPatterns: [
    /(?:hit|exceeded|reached).*(?:your|the)\s*(?:[\w-]+\s+){0,3}limit/i,
    /\d+-hour limit/i,
    /limit reached/i,
    /usage limit/i,
    /out of.*usage/i,
    /rate limit/i,
    /try again in/i,
  ],
  resetPatterns: [
    /resets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i,
    /resets?\s+in[:\s]\s*\d/i,
    /try again in \d+\s*(?:hours?|minutes?|h|m)/i,
    /resets?\s+(?:on\s+)?(?:mon|tue|wed|thu|fri|sat|sun)/i,   // weekly: "resets Tuesday 9am"
    /resets?\s+(?:on\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i,   // weekly: "resets Jul 4 at 12:30am"
  ],
  weeklyPatterns: [
    /week(?:ly)?\s+limit/i,
    /resets?\s+(?:on\s+)?(?:mon|tue|wed|thu|fri|sat|sun)/i,
    /limit.*(?:this|per)\s+week/i,
  ],
  fiveHourPatterns: [/\d+-hour limit/i, /session limit/i],
  // Per-model limits carry NO reset time and are not cleared by waiting:
  //   "You've reached your Fable 5 limit. Run /usage-credits to continue
  //    or switch models with /model."
  // The remedy hint is required, not optional — it is what separates a real
  // banner from an agent discussing usage limits in its own output.
  modelLimitPatterns: [/(?:reached|hit)\s+(?:your|the)\s+[\w.\s-]{0,24}?\blimit\b/i],
  modelRemedyPatterns: [/\/usage-credits\b/i, /switch\s+models?\b/i, /\/model\b/i],
  // While Claude is streaming ("esc to interrupt") or running its own internal
  // retries ("Retrying in 5s · attempt 3/10"), never inject keys.
  busyPatterns: [
    /esc to interrupt/i,
    /\besc\b.*\binterrupt\b/i,
    /Retrying in\b/i,
    /\battempt\s+\d+\/\d+/i,
  ],
  idleRegex: /[❯>]/,
  // Anchored to Claude Code's error render ("API Error: 529") — never bare digits.
  overloadPatterns: [
    /API Error:?\s*\(?5\d\d/i,
    /overloaded_error/i,
    /API Error:?\s*\(?429/i,
    // "API Error: Server is temporarily limiting requests (not your usage
    // limit)" — a server-side throttle. It clears in seconds, so it belongs on
    // this ladder; patterns.js separately refuses to read its parenthetical as
    // a usage limit.
    /temporarily limiting requests/i,
  ],
  transientPatterns: [],   // claude's transient errors are the overload set
  // Stops that waiting cannot clear: notify once, never enter the ledger
  // (monitor.js). Scheduling a wake for these would burn the attempt cap on a
  // condition only a human can fix.
  //
  // All verbatim from the shipped 2.1.233 bundle. The Claude Design ones matter
  // most for headless/unattended runs: a revived session has no interactive
  // terminal, so an expired design credential produces a stop that can never
  // self-resolve. Anchored to the error phrasings rather than to the bare
  // command name, so an agent explaining "/design-login" is not a stop.
  terminalPatterns: [
    /rejected your \/design-login credential/i,
    /could not refresh the design access token/i,
    /could not save the design credential/i,
    /\/design-login requires an interactive terminal/i,
    /credit balance is too low/i,
  ],
};

// --- Interactive /rate-limit-options menu (Claude Code only) ---
// Newer Claude Code shows a selectable menu on limit hit:
//   What do you want to do?
//   ❯ 1. Upgrade your plan
//     2. Stop and wait for limit to reset
// Option order varies between versions — never assume a position; locate the
// cursor and target option and compute the moves. Never blind-Enter (could
// confirm "Upgrade your plan").

const MENU_CURSOR = '❯';
const WAIT_OPTION_REGEX = /stop and wait for limit to reset/i;
const MENU_OPTION_REGEX = /^\s*❯?\s*\d+\.\s/;

export function isRateLimitOptionsPrompt(text, tailLines = 12) {
  const t = contentLines(text, tailLines).join('\n');
  return /what do you want to do\?/i.test(t)
    && WAIT_OPTION_REGEX.test(t)
    && (/enter to confirm/i.test(t) || /esc to cancel/i.test(t) || t.includes(MENU_CURSOR));
}

// Steps (in options) from cursor to the "Stop and wait" option. Positive =>
// Down N times, negative => Up. null => layout unreadable, caller MUST NOT Enter.
export function menuStepsToWaitOption(text, tailLines = 12) {
  const optionLines = contentLines(text, tailLines).filter(l => MENU_OPTION_REGEX.test(l));
  if (optionLines.length === 0) return null;
  const cursorPos = optionLines.findIndex(l => l.includes(MENU_CURSOR));
  const waitPos = optionLines.findIndex(l => WAIT_OPTION_REGEX.test(l));
  if (cursorPos === -1 || waitPos === -1) return null;
  return waitPos - cursorPos;
}

export default {
  id: 'claude',
  name: 'Claude Code',
  bin: process.env.UNSNOOZE_CLAUDE_BIN || 'claude',
  experimental: false,
  patterns,
  menu: { isPrompt: isRateLimitOptionsPrompt, stepsToWait: menuStepsToWaitOption },
  // How to reopen a dead session.
  //
  // Default (a real pane): the prompt is typed into the TUI once it's ready.
  // That path is load-bearing on tmux/zellij/herdr and stays exactly as it was.
  //
  // canType: false (headless — no pane to type into): the prompt rides in argv.
  // `claude --resume <id> "<prompt>"` resumes that session id and acts on the
  // prompt, verified against claude 2.1.233 on 2026-08-16. Without a TTY it
  // runs to completion non-interactively, which is what an unattended overnight
  // resume wants anyway.
  resumeArgs(sessionId, message, { canType = true } = {}) {
    const args = sessionId ? ['--resume', sessionId] : ['-c'];
    if (canType) return { args, messageViaPane: true };
    if (message) args.push(message);
    return { args, messageViaPane: false };
  },
  // v1: every agent launches the bare TUI and gets the prompt typed once idle.
  launchArgs(message) { return { args: [], messageViaPane: true }; },
  latestSessionId,
  // Estimated tokens the API re-reads on a cold wake (prompt cache long
  // expired). null → unknown, contextGuard skips. Adapters without this
  // method are unguarded.
  contextTokens(rec) {
    if (!rec?.cwd || !rec?.sessionId) return null;   // watcher/scrape records may lack either
    return lastUsageTokens(transcriptPath(rec.cwd, rec.sessionId, {
      claudeDir: rec.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR,
    }));
  },
  // The foreground process for a claude session is `node` (nvm shim) or `claude`.
  isForegroundCommand(cmd) {
    return cmd === 'claude' || cmd === 'node' || cmd === 'unsnooze';
  },
};
