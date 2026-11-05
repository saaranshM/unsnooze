// Hermes Agent adapter tests (Nous Research, command `hermes`).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import hermes, { latestSessionId } from '../src/agents/hermes.js';
import { getAgent } from '../src/agents/index.js';
import { detectLimit, isBusy, overloadMatch } from '../src/patterns.js';
import { parseResetTime } from '../src/time-parser.js';

const require = createRequire(import.meta.url);

test('hermes is registered and experimental', () => {
  assert.equal(getAgent('hermes').id, 'hermes');
  assert.equal(hermes.experimental, true);
  assert.equal(hermes.name, 'Hermes Agent (Nous Research)');
});

// --- real Hermes banner variants (from Hermes turn_recovery & turn_failure_copy) ---

const REAL_LIMIT_VARIANTS = [
  '❌ Rate limited after 3 retries — 429 Too Many Requests (resets in 2h 15m)',
  '❌ Rate limited after 3 retries — HTTP 429 rate limit exceeded (resets in 45m)',
  'API call failed after 3 retries: HTTP 429 rate limit exceeded for this model; please retry after 15 minutes.',
  'API call failed after 3 retries: 429 - {\'type\': \'error\', \'error\': {\'type\': \'RateLimitError\', \'message\': \'Too Many Requests\'}}',
  'anthropic rate-limited every one of 3 attempts — its usage limit resets in 2h 15m. Send /retry after that, or switch models with /model.',
  'openai is rate-limiting requests right now — its usage limit resets in 45m. Send /retry after that, or switch models with /model.',
  'Limit resets at 16:30 (in 2h 15m).',
  'You\'ve hit your daily limit · resets 15:56 · /topup to add credits',
];

for (const banner of REAL_LIMIT_VARIANTS) {
  test(`detects limit: "${banner.slice(0, 55)}…"`, () => {
    const pane = `[Hermes]\n\n${banner}\n\n❯ \n`;
    const d = detectLimit(pane, 12, hermes.patterns);
    assert.equal(d.hit, true);
    assert.ok(d.resetLine, 'resetLine should be captured');
  });
}

test('retry banner reset time parses from live countdown', () => {
  const d = detectLimit('❌ Rate limited after 3 retries — 429 Too Many Requests (resets in 2h 15m)\n❯ \n', 12, hermes.patterns);
  const p = parseResetTime(d.resetLine);
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, 2 * 3_600_000 + 15 * 60_000);
});

test('Hermes own retries are transient/busy, NOT limit stops', () => {
  const retryLog = '2026-10-28 01:24:20,404 WARNING agent.conversation_loop: API call failed (attempt 1/3) error_type=RateLimitError thread=hermes-gateway provider=openrouter model=deepseek summary=HTTP 429: Rate limit exceeded\n';
  assert.equal(detectLimit(retryLog, 12, hermes.patterns).hit, false);
  assert.equal(isBusy(retryLog, hermes.patterns.busyPatterns), true);
  assert.ok(overloadMatch(retryLog, hermes.patterns.transientPatterns));

  const retryLine = '⚠️  Attempt 2/3 failed: 429 Too Many Requests\n';
  assert.equal(detectLimit(retryLine, 12, hermes.patterns).hit, false);
  assert.equal(isBusy(retryLine, hermes.patterns.busyPatterns), true);
  assert.ok(overloadMatch(retryLine, hermes.patterns.transientPatterns));
});

test('bare 429 or RateLimitError in tool output does not match', () => {
  const curlPane = '❯ curl -i https://api.github.com/rate_limit\nHTTP/1.1 429 Too Many Requests\nContent-Type: application/json\n\n{"message": "API rate limit exceeded"}\n\n❯ \n';
  assert.equal(detectLimit(curlPane, 12, hermes.patterns).hit, false);

  const pythonErrorPane = 'Traceback (most recent call last):\n  File "script.py", line 10, in <module>\nopenai.RateLimitError: Error code: 429 - Too Many Requests\n\n❯ \n';
  assert.equal(detectLimit(pythonErrorPane, 12, hermes.patterns).hit, false);
});

test('busy patterns match Hermes status text and spinners, NOT agent prose', () => {
  // Hermes actual busy markers
  assert.equal(isBusy('Ctrl+C to interrupt…', hermes.patterns.busyPatterns), true);
  assert.equal(isBusy('esc to interrupt', hermes.patterns.busyPatterns), true);
  assert.equal(isBusy('⚡ Interrupting agent...', hermes.patterns.busyPatterns), true);
  assert.equal(isBusy('running…', hermes.patterns.busyPatterns), true);
  assert.equal(isBusy('summoning hermes…', hermes.patterns.busyPatterns), true);
  assert.equal(isBusy('⠋ Working on task', hermes.patterns.busyPatterns), true);

  // Agent prose mentioning "thinking" or "generating" must NEVER be considered busy
  assert.equal(isBusy('I was thinking we should refactor the auth middleware.\n', hermes.patterns.busyPatterns), false);
  assert.equal(isBusy('Generating the test suite completed successfully.\n', hermes.patterns.busyPatterns), false);
  assert.equal(isBusy('idle\n❯ ', hermes.patterns.busyPatterns), false);
});

test('idle prompt regex matches Hermes prompt glyphs', () => {
  assert.ok(hermes.patterns.idleRegex.test('❯ '));
  assert.ok(hermes.patterns.idleRegex.test('› '));
  assert.ok(hermes.patterns.idleRegex.test('> '));
});

test('provider overload (503) is an overload, NOT a limit', () => {
  const pane1 = 'anthropic reported it was overloaded on all 3 attempts — it looks temporarily unavailable.\n';
  assert.equal(detectLimit(pane1, 12, hermes.patterns).hit, false);
  assert.ok(overloadMatch(pane1, hermes.patterns.overloadPatterns));

  const pane2 = '❌ API failed after 3 retries — 503 Service Unavailable: Model capacity exhausted.\n';
  assert.equal(detectLimit(pane2, 12, hermes.patterns).hit, false);
  assert.ok(overloadMatch(pane2, hermes.patterns.overloadPatterns));
});

test('credit exhaustion is terminal, not a rate limit', () => {
  const pane = 'Billing or credits exhausted: You have exceeded your current quota, please check your plan.\n❯ \n';
  assert.equal(detectLimit(pane, 12, hermes.patterns).hit, false);
  assert.ok(overloadMatch(pane, hermes.patterns.terminalPatterns));

  const pane2 = 'Provider reported usage/credit exhaustion (unverified): credit_balance_exhausted\n❯ \n';
  assert.equal(detectLimit(pane2, 12, hermes.patterns).hit, false);
  assert.ok(overloadMatch(pane2, hermes.patterns.terminalPatterns));
});

test('agent prose about rate limits is not a limit stop', () => {
  const pane = 'I should make sure we handle rate limit errors gracefully when calling external APIs.\n\n❯ \n';
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
  assert.equal(latestSessionId('/tmp/anywhere', null, '/nonexistent/hermes/dir'), 'latest');
});

test('latestSessionId queries state.db correctly by cwd and activity order', () => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {}

  const tempDir = mkdtempSync(join(tmpdir(), 'unsnooze-hermes-test-'));
  try {
    if (DatabaseSync) {
      const db = new DatabaseSync(join(tempDir, 'state.db'));
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          cwd TEXT,
          started_at REAL NOT NULL,
          last_activity_at REAL
        );
        INSERT INTO sessions (id, cwd, started_at, last_activity_at) VALUES
          ('old-session', '/project/alpha', 1000, 1500),
          ('new-session', '/project/alpha', 1100, 2500),
          ('other-project', '/project/beta', 1200, 3000);
      `);
      db.close();

      const resultAlpha = latestSessionId('/project/alpha', null, tempDir);
      assert.equal(resultAlpha, 'new-session');

      const resultBeta = latestSessionId('/project/beta', null, tempDir);
      assert.equal(resultBeta, 'other-project');

      const resultGamma = latestSessionId('/project/gamma', null, tempDir);
      assert.equal(resultGamma, 'latest');
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
