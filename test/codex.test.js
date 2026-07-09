// Codex CLI adapter: banner detection fixtures use the exact strings from
// codex-rs/protocol/src/error.rs (see plan/research), so a Codex TUI update
// that changes them should fail here, loudly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import codex from '../src/agents/codex.js';
import { getAgent } from '../src/agents/index.js';
import { detectLimit, isBusy, overloadMatch } from '../src/patterns.js';
import { parseResetTime, resetAtMs } from '../src/time-parser.js';

const MARGIN = 60_000;

test('codex is registered', () => {
  assert.equal(getAgent('codex').id, 'codex');
});

// --- banner variants (verbatim per plan) ---

const VARIANTS = [
  "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:51 PM.",
  "■ You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 9:01 PM.",
  "■ You've hit your usage limit. To get more access now, send a request to your admin or try again at Apr 7th, 2026 1:07 AM.",
  "■ You've hit your usage limit. Try again later.",
  "■ You've hit your usage limit for gpt-5-codex. Switch to another model now, or try again at 4:10 PM.",
  "You've hit your usage limit. Try again in 4 days 20 hours 9 minutes.",
];

for (const banner of VARIANTS) {
  test(`detects limit: "${banner.slice(0, 60)}…"`, () => {
    const pane = `⏺ working on it\n\n${banner}\n\n› Ask Codex to do anything\n`;
    const d = detectLimit(pane, 12, codex.patterns);
    assert.equal(d.hit, true);
    assert.ok(d.resetLine, 'resetLine should be captured');
  });
}

test('workspace credit variants detected', () => {
  const d = detectLimit('■ Your workspace is out of credits. Add credits to continue.\n› \n', 12, codex.patterns);
  assert.equal(d.hit, true);
});

test('transient stream errors are NOT usage limits but ARE overloads', () => {
  const pane = '⚠ stream error: exceeded retry limit, last status: 429 Too Many Requests; retrying 4/5 in 1.471s\n';
  assert.equal(detectLimit(pane, 12, codex.patterns).hit, false);
  assert.ok(overloadMatch(pane, codex.patterns.overloadPatterns));
});

test('busy and idle markers', () => {
  assert.equal(isBusy('• Working (12s • esc to interrupt)\n', codex.patterns.busyPatterns), true);
  const idle = '› Ask Codex to do anything\n\ngpt-5.6 default · /tmp/project\n';
  assert.equal(isBusy(idle, codex.patterns.busyPatterns), false);
  assert.equal(codex.patterns.idleRegex.test(idle), true);
});

// --- resume invocation ---

test('codex resume args carry the message in argv', () => {
  const withId = codex.resumeArgs('0199a213-81c0-7800-8aa1-bbab2a035a53', 'continue');
  assert.deepEqual(withId.args, ['resume', '0199a213-81c0-7800-8aa1-bbab2a035a53', 'continue']);
  assert.equal(withId.messageViaPane, false);
  const noId = codex.resumeArgs(null, 'continue');
  assert.deepEqual(noId.args, ['resume', '--last', 'continue']);
});

test('codex foreground command check', () => {
  assert.equal(codex.isForegroundCommand('codex'), true);
  assert.equal(codex.isForegroundCommand('zsh'), false);
});

// --- time-parser extensions for codex formats ---

test('parses "or try again at 3:51 PM."', () => {
  const p = parseResetTime('■ You\'ve hit your usage limit. … or try again at 3:51 PM.');
  assert.equal(p.hour, 15);
  assert.equal(p.minute, 51);
});

test('parses cross-day "try again at Feb 23rd, 2026 9:01 PM."', () => {
  const p = parseResetTime('or try again at Feb 23rd, 2026 9:01 PM.');
  assert.equal(p.absolute, true);
  const expected = new Date(2026, 1, 23, 21, 1).getTime();
  assert.equal(p.atMs, expected);
  const { at, source } = resetAtMs(p, { marginMs: MARGIN, now: new Date(2026, 1, 20) });
  assert.equal(source, 'absolute');
  assert.equal(at, expected + MARGIN);
});

test('parses multi-unit "Try again in 4 days 20 hours 9 minutes."', () => {
  const p = parseResetTime('Try again in 4 days 20 hours 9 minutes.');
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, ((4 * 24 + 20) * 60 + 9) * 60_000);
});

test('"Try again later." yields no parse (fallback path)', () => {
  assert.equal(parseResetTime("You've hit your usage limit. Try again later."), null);
});
