// Per-model limits: the stop unsnooze could not see.
//
//   You've reached your Fable 5 limit. Run /usage-credits to continue or
//   switch models with /model.
//
// There is no reset time in it, so the paired limit+time detection never
// fired and no StopFailure hook arrived either — the session simply stopped,
// untracked. It also cannot be resumed by waiting: only a human switching
// models or adding credits clears it. Both halves have to be right, because a
// wake typed into a still-limited pane is worse than no wake at all.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-model-limit-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';

const { detectLimit } = await import('../src/patterns.js');
const claude = (await import('../src/agents/claude.js')).default;

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const BANNER = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";
const scan = text => detectLimit(text, 20, claude.patterns);

test('the real banner is detected, with no reset time to schedule', () => {
  const d = scan(['> summarise the diff', '', BANNER, ''].join('\n'));
  assert.equal(d.hit, true);
  assert.equal(d.limitType, 'model');
  assert.equal(d.resetLine, null, 'nothing to schedule — only something to probe for');
});

test('the banner split across two lines, as a narrow pane wraps it', () => {
  const d = scan(["You've reached your Fable 5 limit. Run /usage-credits to", 'continue or switch models with /model.'].join('\n'));
  assert.equal(d.hit, true);
  assert.equal(d.limitType, 'model');
});

// The false positive the review reproduced: an agent explaining the banner
// writes the same words, remedy hints included.
test('an agent QUOTING the banner is not a stop', () => {
  for (const quoted of [
    `The error you saw was "${BANNER}"`,
    `> ${BANNER}`,
    `\`${BANNER}\``,
    ['Here is what it said:', '```', BANNER, '```'].join('\n'),
    `'${BANNER}'`,
  ]) {
    const d = scan(quoted);
    assert.equal(d.hit, false, `must not fire on quoted prose: ${quoted.slice(0, 60)}…`);
  }
});

test('prose about limits without the banner is not a stop either', () => {
  const d = scan([
    'You could hit your usage limit if you keep going.',
    'If that happens, run /usage-credits.',
  ].join('\n'));
  assert.equal(d.hit, false, 'discussion is not a banner');
});

test('a remedy hint the agent is quoting cannot corroborate a bare limit line', () => {
  const d = scan([
    "You've reached your Fable 5 limit.",
    'The docs say to run `/usage-credits` when that happens.',
  ].join('\n'));
  assert.equal(d.hit, false, 'the only remedy nearby is quoted, so it is not evidence');
});

test('a time-based limit still detects as before — this pass is additive', () => {
  const d = scan(['Claude usage limit reached. Your limit will reset at 3pm (UTC).'].join('\n'));
  assert.equal(d.hit, true);
  assert.notEqual(d.limitType, 'model', 'a banner with a reset time is not a model limit');
  assert.ok(d.resetLine, 'and it keeps the line it schedules from');
});
