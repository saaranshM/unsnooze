import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLimit, isBusy, overloadMatch, stripAnsi } from '../src/patterns.js';
import { isRateLimitOptionsPrompt, menuStepsToWaitOption } from '../src/agents/claude.js';

const BANNER_5H = [
  '⏺ Working on the refactor...',
  '',
  "⚠ You've hit your 5-hour limit",
  '· resets 3pm (UTC)',
  '',
  '> ',
].join('\n');

const BANNER_WEEKLY = [
  'some output',
  "You've reached your weekly limit",
  '· resets Tuesday 9am',
  '> ',
].join('\n');

const BANNER_GENERIC = [
  'Usage limit reached — try again in 2 hours',
  '> ',
].join('\n');

const CLEAN_PANE = [
  'Editing src/foo.js',
  '⏺ All tests pass.',
  '> ',
].join('\n');

test('detects 5-hour limit banner with reset line', () => {
  const r = detectLimit(BANNER_5H);
  assert.equal(r.hit, true);
  assert.equal(r.limitType, '5h');
  assert.match(r.resetLine, /resets 3pm/);
});

test('detects weekly limit banner', () => {
  const r = detectLimit(BANNER_WEEKLY);
  assert.equal(r.hit, true);
  assert.equal(r.limitType, 'weekly');
  assert.match(r.resetLine, /Tuesday 9am/);
});

test('detects generic usage-limit + relative reset', () => {
  const r = detectLimit(BANNER_GENERIC);
  assert.equal(r.hit, true);
  assert.match(r.resetLine, /try again in 2 hours/i);
});

test('no false positive on clean pane', () => {
  assert.equal(detectLimit(CLEAN_PANE).hit, false);
});

test('limit words WITHOUT reset line do not trigger', () => {
  const pane = 'we discussed the usage limit design today\n> ';
  assert.equal(detectLimit(pane).hit, false);
});

test('banner outside tail window is ignored (scrollback)', () => {
  const pane = BANNER_5H + '\n' + Array(20).fill('more output after resume').join('\n');
  assert.equal(detectLimit(pane, 12).hit, false);
});

test('banner followed by blank pane padding is still detected', () => {
  // capture-pane pads the visible pane with empty rows below the content —
  // the tail window must apply to content, not screen rows.
  const pane = BANNER_5H + '\n' + Array(20).fill('').join('\n');
  assert.equal(detectLimit(pane, 12).hit, true);
});

test('strips ANSI before matching', () => {
  const pane = "\x1b[33m⚠ You've hit your 5-hour limit\x1b[0m\n\x1b[2m· resets 3pm (UTC)\x1b[0m\n> ";
  const r = detectLimit(pane);
  assert.equal(r.hit, true);
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
});

const MENU = [
  "You've hit your limit.",
  'What do you want to do?',
  '❯ 1. Upgrade your plan',
  '  2. Stop and wait for limit to reset',
  '(enter to confirm · esc to cancel)',
].join('\n');

test('rate-limit-options menu detected and steps computed', () => {
  assert.equal(isRateLimitOptionsPrompt(MENU), true);
  assert.equal(menuStepsToWaitOption(MENU), 1);
});

test('menu with wait option first needs 0 steps', () => {
  const m = MENU.replace('❯ 1. Upgrade your plan', '  1. Upgrade your plan')
    .replace('  2. Stop and wait', '❯ 2. Stop and wait');
  assert.equal(menuStepsToWaitOption(m), 0);
});

test('unreadable menu returns null (never blind Enter)', () => {
  assert.equal(menuStepsToWaitOption('What do you want to do?\nno options here'), null);
});

test('isBusy on streaming footer and internal retries', () => {
  assert.equal(isBusy('✻ Thinking… (esc to interrupt)'), true);
  assert.equal(isBusy('API Error (529) · Retrying in 5s · attempt 3/10'), true);
  assert.equal(isBusy(CLEAN_PANE), false);
});

test('overloadMatch anchored to error render, not bare digits', () => {
  const patterns = ['API Error:?\\s*\\(?5\\d\\d', 'overloaded_error'];
  assert.ok(overloadMatch('API Error: 529 overloaded\n> ', patterns));
  assert.ok(overloadMatch('{"type":"overloaded_error"}\n> ', patterns));
  assert.equal(overloadMatch('HTTP returned 503 in my test suite\n> ', patterns), null);
});
