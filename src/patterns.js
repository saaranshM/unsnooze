// Detection of Claude Code usage-limit banners in tmux pane text.
// Ported from claude-auto-retry's proven pattern set, extended with limit-type
// classification (5h vs weekly) so the resumer can pick sensible fallbacks.

// ANSI stripping — full CSI/OSC/DCS/APC coverage per ECMA-48.
const CSI_REGEX = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g;
const OSC_REGEX = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const DCS_REGEX = /\x1bP[\s\S]*?(?:\x07|\x1b\\)/g;
const OTHER_ESC_REGEX = /\x1b[_X^][\s\S]*?(?:\x07|\x1b\\)/g;

export function stripAnsi(text) {
  return text
    .replace(OSC_REGEX, '')
    .replace(DCS_REGEX, '')
    .replace(OTHER_ESC_REGEX, '')
    .replace(CSI_REGEX, '');
}

// Claude Code renders limits across multiple TUI lines, e.g.:
//   "⚠ You've hit your 5-hour limit"
//   "· resets 3pm (UTC)"
// Detection requires a "limit" line AND a "resets" line within PROXIMITY lines
// of each other, scanning only the tail of the pane (a live banner sits at the
// prompt; the same words in scrollback are history, not current state).

const LIMIT_PATTERNS = [
  /(?:hit|exceeded|reached).*(?:your|the)\s*(?:[\w-]+\s+){0,3}limit/i,
  /\d+-hour limit/i,
  /limit reached/i,
  /usage limit/i,
  /out of.*usage/i,
  /rate limit/i,
  /try again in/i,
];

const RESET_PATTERNS = [
  /resets?\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i,
  /resets?\s+in[:\s]\s*\d/i,
  /try again in \d+\s*(?:hours?|minutes?|h|m)/i,
  /resets?\s+(?:on\s+)?(?:mon|tue|wed|thu|fri|sat|sun)/i,   // weekly: "resets Tuesday 9am"
];

const WEEKLY_PATTERNS = [
  /week(?:ly)?\s+limit/i,
  /resets?\s+(?:on\s+)?(?:mon|tue|wed|thu|fri|sat|sun)/i,
  /limit.*(?:this|per)\s+week/i,
];

const PROXIMITY = 6;

// tmux capture-pane pads the visible pane with blank rows below the last
// content (a fresh pane shows a banner at the top and 20 empty rows under it).
// The "last N lines" tail must be taken from the CONTENT, not the screen rows,
// or a banner above the padding escapes the window.
function contentLines(text, tailLines) {
  const lines = stripAnsi(text).split('\n');
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  const trimmed = lines.slice(0, end);
  return tailLines > 0 ? trimmed.slice(-tailLines) : trimmed;
}

function hasNearbyMatch(lines, idx, patterns) {
  const start = Math.max(0, idx - PROXIMITY);
  const end = Math.min(lines.length, idx + PROXIMITY + 1);
  for (let j = start; j < end; j++) {
    if (patterns.some(p => p.test(lines[j]))) return true;
  }
  return false;
}

// Main entry: detect a live usage-limit banner in the pane tail.
// Returns { hit, limitType: '5h'|'weekly'|'unknown', resetLine } — resetLine is
// the text to feed to time-parser (most recent reset mention, bottom-up).
export function detectLimit(text, tailLines = 12) {
  const lines = contentLines(text, tailLines);

  let hit = false;
  for (let i = 0; i < lines.length; i++) {
    if (LIMIT_PATTERNS.some(p => p.test(lines[i])) && hasNearbyMatch(lines, i, RESET_PATTERNS)) {
      hit = true;
      break;
    }
  }
  if (!hit) return { hit: false, limitType: null, resetLine: null };

  const joined = lines.join('\n');
  let limitType = 'unknown';
  if (WEEKLY_PATTERNS.some(p => p.test(joined))) limitType = 'weekly';
  else if (/\d+-hour limit/i.test(joined) || /session limit/i.test(joined)) limitType = '5h';

  // Most recent reset line wins (the TUI never clears old banners from scrollback).
  let resetLine = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (RESET_PATTERNS.some(p => p.test(lines[i]))) { resetLine = lines[i].trim(); break; }
  }
  if (!resetLine) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (LIMIT_PATTERNS.some(p => p.test(lines[i]))) { resetLine = lines[i].trim(); break; }
    }
  }
  return { hit: true, limitType, resetLine };
}

// --- Interactive /rate-limit-options menu ---
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

// --- Busy / overload detection ---
// While Claude is streaming ("esc to interrupt") or running its own internal
// retries ("Retrying in 5s · attempt 3/10"), the pane is NOT in a terminal
// state — never inject keys then.

const WORKING_PATTERNS = [
  /esc to interrupt/i,
  /\besc\b.*\binterrupt\b/i,
  /Retrying in\b/i,
  /\battempt\s+\d+\/\d+/i,
];

function tail(text, n = 12) {
  return contentLines(text, n);
}

export function isBusy(text) {
  return tail(text).some(line => WORKING_PATTERNS.some(p => p.test(line)));
}

// Overload patterns are config-driven strings, anchored to Claude Code's actual
// error render ("API Error: 529", "overloaded_error") — never bare digits.
export function overloadMatch(text, patterns = []) {
  if (!patterns || patterns.length === 0) return null;
  const lines = tail(text);
  if (!lines.join('').trim()) return null;
  const regexes = [];
  for (const p of patterns) {
    if (p instanceof RegExp) { regexes.push(p); continue; }
    if (typeof p !== 'string' || !p) continue;
    try { regexes.push(new RegExp(p, 'i')); } catch { /* skip invalid */ }
  }
  for (const line of lines) {
    for (const r of regexes) {
      if (r.test(line)) return { pattern: r.source, line: line.trim().slice(0, 200) };
    }
  }
  return null;
}
