// OpenCode adapter: banner fixtures use the exact strings from sst/opencode
// (packages/opencode/src/session/retry.ts, packages/tui prompt status line,
// console zen i18n) — an OpenCode update that changes them should fail here.
//
// Design under test: OpenCode self-retries rate limits forever (honoring
// retry-after), so the retry banner is BOTH a limit anchor (dead panes mid-wait
// must be revivable) AND a busy pattern (live panes must never be injected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import opencode, { latestSessionId } from '../src/agents/opencode.js';
import { getAgent } from '../src/agents/index.js';
import { detectLimit, isBusy, overloadMatch } from '../src/patterns.js';
import { parseResetTime } from '../src/time-parser.js';

test('opencode is registered and experimental', () => {
  assert.equal(getAgent('opencode').id, 'opencode');
  assert.equal(opencode.experimental, true);
});

// --- banner variants (verbatim per research) ---

const LIMIT_VARIANTS = [
  'Rate Limited [retrying in 30s attempt #2]',
  'Too Many Requests [retrying in 2m 5s attempt #3]',
  'Free usage exceeded, subscribe to Go [retrying in 1h 30m attempt #5]',
  '5 hour usage limit reached. It will reset in 2 hours 5 minutes. To continue using this model now, enable usage from y... (click to expand) [retrying in 2h5m attempt #4]',
  'weekly usage limit reached. It will reset in 1 day 3 hours. To continue using this model now, enable usage from your... (click to expand) [retrying in ~1 day attempt #7]',
  'Subscription quota exceeded. Retry in 45 minutes.',
  'Rate limit exceeded: limit_rpd/deepseek-r1-0528:free [retrying in 60s attempt #3]',
];

for (const banner of LIMIT_VARIANTS) {
  test(`detects limit: "${banner.slice(0, 55)}…"`, () => {
    const pane = `⏺ working on it\n\n${banner}\n\n> \n`;
    const d = detectLimit(pane, 12, opencode.patterns);
    assert.equal(d.hit, true);
    assert.ok(d.resetLine, 'resetLine should be captured');
  });
}

test('limitType from the Zen banner text', () => {
  assert.equal(detectLimit('5 hour usage limit reached. It will reset in 2 hours 5 minutes.\n> \n', 12, opencode.patterns).limitType, '5h');
  assert.equal(detectLimit('weekly usage limit reached. It will reset in 1 day 3 hours.\n> \n', 12, opencode.patterns).limitType, 'weekly');
});

test('retry banner reset time parses from the live countdown', () => {
  const d = detectLimit('Rate Limited [retrying in 2h5m attempt #4]\n> \n', 12, opencode.patterns);
  const p = parseResetTime(d.resetLine);
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, 2 * 3_600_000 + 5 * 60_000);
});

test('a self-retrying pane is busy — never inject keys', () => {
  const pane = 'Rate Limited [retrying in 30s attempt #2]\nesc interrupt\n';
  assert.equal(isBusy(pane, opencode.patterns.busyPatterns), true);
});

test('provider overload is an overload, NOT a limit', () => {
  const pane = 'Provider is overloaded [retrying in 30s attempt #2]\n';
  assert.equal(detectLimit(pane, 12, opencode.patterns).hit, false);
  assert.ok(overloadMatch(pane, opencode.patterns.overloadPatterns));
  assert.equal(isBusy(pane, opencode.patterns.busyPatterns), true);
});

test('credit exhaustion (402) is terminal, not a limit', () => {
  const pane = 'Insufficient credits. Add more using https://openrouter.ai/settings/credits\n> \n';
  assert.equal(detectLimit(pane, 12, opencode.patterns).hit, false);
  assert.ok(overloadMatch(pane, opencode.patterns.terminalPatterns));
});

test('agent prose about rate limits is not a limit stop', () => {
  const pane = '⏺ The scraper should respect the API rate limit and back off\n  when it sees too many requests errors.\n\n> \n';
  assert.equal(detectLimit(pane, 12, opencode.patterns).hit, false);
});

// --- resume invocation ---

test('opencode resume args (message typed into TUI)', () => {
  const withId = opencode.resumeArgs('ses_8f0c2a1b3d', 'continue');
  assert.deepEqual(withId.args, ['-s', 'ses_8f0c2a1b3d']);
  assert.equal(withId.messageViaPane, true);
  const noId = opencode.resumeArgs(null, 'continue');
  assert.deepEqual(noId.args, ['--continue']);
});

test('opencode foreground command check', () => {
  assert.equal(opencode.isForegroundCommand('opencode'), true);
  // The npm-shipped binary reports as "opencode.exe" even on macOS (verified live).
  assert.equal(opencode.isForegroundCommand('opencode.exe'), true);
  assert.equal(opencode.isForegroundCommand('node'), true);
  assert.equal(opencode.isForegroundCommand('zsh'), false);
});

// --- latestSessionId shells out to `opencode session list --format json` ---

const SESSIONS = [
  { id: 'ses_old111', directory: '/tmp/proj-oc', time_updated: 1000 },
  { id: 'ses_new222', directory: '/tmp/proj-oc', time_updated: 2000 },
  { id: 'ses_other3', directory: '/somewhere/else', time_updated: 3000 },
];

test('latestSessionId picks the newest session for the cwd (JSON array output)', () => {
  const runner = () => JSON.stringify(SESSIONS);
  assert.equal(latestSessionId('/tmp/proj-oc', null, runner), 'ses_new222');
});

test('latestSessionId tolerates JSONL line output', () => {
  const runner = () => SESSIONS.map(s => JSON.stringify(s)).join('\n') + '\n';
  assert.equal(latestSessionId('/tmp/proj-oc', null, runner), 'ses_new222');
});

test('latestSessionId is null when the CLI fails or nothing matches', () => {
  assert.equal(latestSessionId('/tmp/proj-oc', null, () => { throw new Error('no opencode'); }), null);
  assert.equal(latestSessionId('/nope', null, () => JSON.stringify(SESSIONS)), null);
});
