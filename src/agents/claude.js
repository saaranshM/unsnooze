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
  ],
  transientPatterns: [],   // claude's transient errors are the overload set
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
  // How to reopen a dead session. messageViaPane: the resume prompt is typed
  // into the TUI once it's ready (claude has no resume-with-prompt argv form).
  resumeArgs(sessionId) {
    return { args: sessionId ? ['--resume', sessionId] : ['-c'], messageViaPane: true };
  },
  // v1: every agent launches the bare TUI and gets the prompt typed once idle.
  launchArgs(message) { return { args: [], messageViaPane: true }; },
  latestSessionId,
  // Estimated tokens the API re-reads on a cold wake (prompt cache long
  // expired). null → unknown, contextGuard skips. Adapters without this
  // method are unguarded.
  contextTokens(rec) {
    if (!rec?.cwd || !rec?.sessionId) return null;   // watcher/scrape records may lack either
    return lastUsageTokens(transcriptPath(rec.cwd, rec.sessionId));
  },
  // The foreground process for a claude session is `node` (nvm shim) or `claude`.
  isForegroundCommand(cmd) {
    return cmd === 'claude' || cmd === 'node' || cmd === 'unsnooze';
  },
};
