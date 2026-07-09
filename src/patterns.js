// Detection ENGINE for usage-limit banners in tmux pane text. Agent-agnostic:
// every regex set comes from an agent adapter (src/agents/*), with claude as
// the default so pre-adapter call sites keep working.
//
// Detection requires a "limit" line AND a "resets" line within PROXIMITY lines
// of each other, scanning only the tail of the pane (a live banner sits at the
// prompt; the same words in scrollback are history, not current state).

import { patterns as claudePatterns } from './agents/claude.js';

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

const PROXIMITY = 6;

// tmux capture-pane pads the visible pane with blank rows below the last
// content (a fresh pane shows a banner at the top and 20 empty rows under it).
// The "last N lines" tail must be taken from the CONTENT, not the screen rows,
// or a banner above the padding escapes the window.
export function contentLines(text, tailLines) {
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
export function detectLimit(text, tailLines = 12, sets = claudePatterns) {
  const lines = contentLines(text, tailLines);

  let hit = false;
  for (let i = 0; i < lines.length; i++) {
    if (sets.limitPatterns.some(p => p.test(lines[i])) && hasNearbyMatch(lines, i, sets.resetPatterns)) {
      hit = true;
      break;
    }
  }
  if (!hit) return { hit: false, limitType: null, resetLine: null };

  const joined = lines.join('\n');
  let limitType = 'unknown';
  if (sets.weeklyPatterns.some(p => p.test(joined))) limitType = 'weekly';
  else if ((sets.fiveHourPatterns || []).some(p => p.test(joined))) limitType = '5h';

  // Most recent reset line wins (the TUI never clears old banners from scrollback).
  let resetLine = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (sets.resetPatterns.some(p => p.test(lines[i]))) { resetLine = lines[i].trim(); break; }
  }
  if (!resetLine) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (sets.limitPatterns.some(p => p.test(lines[i]))) { resetLine = lines[i].trim(); break; }
    }
  }
  return { hit: true, limitType, resetLine };
}

function tail(text, n = 12) {
  return contentLines(text, n);
}

// While the agent is streaming or running its own internal retries, the pane
// is NOT in a terminal state — never inject keys then.
export function isBusy(text, busyPatterns = claudePatterns.busyPatterns) {
  return tail(text).some(line => busyPatterns.some(p => p.test(line)));
}

// Overload patterns are adapter-supplied, anchored to the CLI's actual error
// render ("API Error: 529", "overloaded_error") — never bare digits.
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
