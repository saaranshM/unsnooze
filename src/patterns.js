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

// `skip` (optional) marks lines that must not count as corroboration — a
// remedy hint the agent is quoting is not the terminal offering a remedy.
function hasNearbyMatch(lines, idx, patterns, skip = null) {
  const start = Math.max(0, idx - PROXIMITY);
  const end = Math.min(lines.length, idx + PROXIMITY + 1);
  for (let j = start; j < end; j++) {
    if (skip && skip[j]) continue;
    if (patterns.some(p => p.test(lines[j])
      && !(skip && inlineQuoted(lines[j], p)))) return true;
  }
  return false;
}

// Whether the text this pattern matched is wrapped in backticks or quotes
// where it sits — `/usage-credits` written mid-sentence is the agent citing a
// command, not the terminal offering one.
function inlineQuoted(line, pattern) {
  const m = line.match(pattern);
  if (!m) return false;
  const before = line[m.index - 1];
  const after = line[m.index + m[0].length];
  return (before === '`' && after === '`')
    || (before === '"' && after === '"')
    || (before === "'" && after === "'");
}

// Main entry: detect a live usage-limit banner in the pane tail.
// Returns { hit, limitType: '5h'|'weekly'|'unknown', resetLine } — resetLine is
// the text to feed to time-parser (most recent reset mention, bottom-up).
// Which lines are the agent quoting rather than the terminal showing.
// Fences are tracked across the window so a banner pasted inside ``` is
// excluded even when the individual line looks bare.
// "you could hit your limit", "this may hit the limit" — a warning about a
// limit that has not happened. The banner always asserts that it has.
const HYPOTHETICAL_LIMIT = /\b(?:could|would|might|may|will|can|if you)\b[^.]{0,40}?\b(?:reached|hit)\b/i;

function quotedLineFlags(lines) {
  const flags = new Array(lines.length).fill(false);
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; flags[i] = true; continue; }
    if (inFence) { flags[i] = true; continue; }
    flags[i] = /^[>|]/.test(line)                      // markdown quote / table cell
      || /^[`"'\u201c\u2018]/.test(line)                // opens with a quote or backtick
      || /[`"'\u201d\u2019][.,;:!?]?$/.test(line);      // closes with one
  }
  return flags;
}

export function detectLimit(text, tailLines = 12, sets = claudePatterns) {
  const lines = contentLines(text, tailLines);

  let hit = false;
  for (let i = 0; i < lines.length; i++) {
    if (sets.limitPatterns.some(p => p.test(lines[i])) && hasNearbyMatch(lines, i, sets.resetPatterns)) {
      hit = true;
      break;
    }
  }
  // A per-model limit has no reset time to pair with, so the loop above can
  // never see it. Detect it separately — a limit phrase backed by the banner's
  // own remedy hint (/model, /usage-credits) — and report it with a null
  // resetLine: there is nothing to schedule, only something to probe for.
  if (!hit && (sets.modelLimitPatterns || []).length) {
    const quoted = quotedLineFlags(lines);
    for (let i = 0; i < lines.length; i++) {
      // The remedy hint alone is not evidence: an agent explaining what the
      // banner says writes the same words, including `/model`. What separates
      // them is that prose QUOTES it — in backticks, in quotation marks, in a
      // fenced block, or behind a markdown quote marker — while the terminal's
      // own banner is plain. Reproduced in production before this check: an
      // assistant paragraph about usage limits recorded a stop on the first
      // monitor tick.
      if (quoted[i] || HYPOTHETICAL_LIMIT.test(lines[i])) continue;
      if (sets.modelLimitPatterns.some(p => p.test(lines[i]))
        && hasNearbyMatch(lines, i, sets.modelRemedyPatterns || [], quoted)) {
        return { hit: true, limitType: 'model', resetLine: null };
      }
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
