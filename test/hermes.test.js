// Hermes Agent adapter tests (Nous Research, command `hermes`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import hermes, { latestSessionId } from '../src/agents/hermes.js';
import { getAgent } from '../src/agents/index.js';
import { detectLimit, isBusy, overloadMatch } from '../src/patterns.js';
import { parseResetTime } from '../src/time-parser.js';

test('hermes is registered and experimental', () => {
  assert.equal(getAgent('hermes').id, 'hermes');
  assert.equal(hermes.experimental, true);
  assert.equal(hermes.name, 'Hermes Agent (Nous Research)');
});

// --- banner variants ---

const LIMIT_VARIANTS = [
  'HTTP 429: Free usage limit reached. Free models work in OpenCode; subscribe to OpenCode Go to keep going: https://opencode.ai/go',
  'openai.RateLimitError: Error code: 429 - {\'type\': \'error\', \'error\': {\'type\': \'FreeUsageLimitError\', \'message\': \'Free usage limit reached.\'}}',
  '2026-10-28 01:24:20,404 WARNING agent.conversation_loop: API call failed (attempt 1/3) error_type=RateLimitError thread=hermes-gateway provider=opencode-zen model=deepseek-v4.1-flash-free summary=HTTP 429: Free usage limit reached.',
  'Rate limit exceeded. Please retry after 15 minutes.',
  'Too Many Requests. Retry in 2 hours 30 minutes.',
  'RESOURCE_EXHAUSTED: Quota limit exceeded for model gemini-2.5-pro. Resets in 4 hours.',
];

for (const banner of LIMIT_VARIANTS) {
  test(`detects limit: "${banner.slice(0, 55)}…"`, () => {
    const pane = `[Hermes]\n\n${banner}\n\n› \n`;
    const d = detectLimit(pane, 12, hermes.patterns);
    assert.equal(d.hit, true);
    assert.ok(d.resetLine, 'resetLine should be captured');
  });
}

test('retry banner reset time parses from live countdown', () => {
  const d = detectLimit('Rate limit exceeded. Retry in 2h 15m.\n› \n', 12, hermes.patterns);
  const p = parseResetTime(d.resetLine);
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, 2 * 3_600_000 + 15 * 60_000);
});

test('busy patterns match thinking or running tool calls', () => {
  assert.equal(isBusy('Thinking… (esc to interrupt)', hermes.patterns.busyPatterns), true);
  assert.equal(isBusy('tool call in progress: terminal\n', hermes.patterns.busyPatterns), true);
  assert.equal(isBusy('Generating response…', hermes.patterns.busyPatterns), true);
  assert.equal(isBusy('idle\n› ', hermes.patterns.busyPatterns), false);
});

test('provider overload is an overload, NOT a limit', () => {
  const pane = 'HTTP 503: Model capacity exhausted. Provider overloaded.\n';
  assert.equal(detectLimit(pane, 12, hermes.patterns).hit, false);
  assert.ok(overloadMatch(pane, hermes.patterns.overloadPatterns));
});

test('credit exhaustion is terminal, not a rate limit', () => {
  const pane = 'credit_balance_exhausted: Out of credits. Please recharge your account.\n› \n';
  assert.equal(detectLimit(pane, 12, hermes.patterns).hit, false);
  assert.ok(overloadMatch(pane, hermes.patterns.terminalPatterns));
});

test('agent prose about rate limits is not a limit stop', () => {
  const pane = 'I should make sure we handle rate limit errors gracefully when calling external APIs.\n\n› \n';
  assert.equal(detectLimit(pane, 12, hermes.patterns).hit, false);
});

// --- resume invocation ---

test('hermes resume args', () => {
  const withId = hermes.resumeArgs('local-63d4b2f9e30b6faec29a82496cd08b4498fb83e3d729c42ab0cd67d8379b04e6');
  assert.deepEqual(withId.args, ['--resume', 'local-63d4b2f9e30b6faec29a82496cd08b4498fb83e3d729c42ab0cd67d8379b04e6']);
  assert.equal(withId.messageViaPane, true);

  const fallback = hermes.resumeArgs(null);
  assert.deepEqual(fallback.args, ['--resume', 'latest']);

  const latestStr = hermes.resumeArgs('latest');
  assert.deepEqual(latestStr.args, ['--resume', 'latest']);
});

test('hermes foreground command check', () => {
  assert.equal(hermes.isForegroundCommand('hermes'), true);
  assert.equal(hermes.isForegroundCommand('hermes.exe'), true);
  assert.equal(hermes.isForegroundCommand('python'), true);
  assert.equal(hermes.isForegroundCommand('python3'), true);
  assert.equal(hermes.isForegroundCommand('node'), true);
  assert.equal(hermes.isForegroundCommand('unsnooze'), true);
  assert.equal(hermes.isForegroundCommand('bash'), false);
  assert.equal(hermes.isForegroundCommand('cargo'), false);
});

test('latestSessionId falls back to latest when state.db is missing', () => {
  process.env.HERMES_HOME = '/nonexistent/path/for/test';
  assert.equal(latestSessionId('/tmp/anywhere'), 'latest');
  delete process.env.HERMES_HOME;
});
