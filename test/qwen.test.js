// Qwen Code CLI adapter: banner fixtures use the exact strings from
// QwenLM/qwen-code (packages/core/src/utils/retry.ts, errorParsing.ts,
// rateLimit.test.ts) — a TUI update that changes them should fail here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import qwen, { latestSessionId, sanitizeCwd } from '../src/agents/qwen.js';
import { getAgent } from '../src/agents/index.js';
import { detectLimit, isBusy, overloadMatch } from '../src/patterns.js';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-qwen-test-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

test('qwen is registered and experimental', () => {
  assert.equal(getAgent('qwen').id, 'qwen');
  assert.equal(qwen.experimental, true);
});

// --- banner variants (verbatim per research) ---

const LIMIT_VARIANTS = [
  // legacy free-tier era (v0.11–v0.13)
  '✕ Qwen OAuth quota exceeded: Your free daily quota has been reached.',
  // v0.10.x era
  '✕ Qwen API quota exceeded: Your Qwen API quota has been exhausted. Please wait for your quota to reset.',
  // Coding Plan (Throttling.AllocationQuota) — current paid path
  '✕ Allocated quota exceeded, please increase your quota limit.',
  // raw server text
  '✕ 429 Free allocated quota exceeded.',
  // OpenAI-compat provider 429 (incl. OpenRouter) with qwen's quota suffix
  '[API Error: 429 rate limit exceeded (Status: 429)]\nPossible quota limitations in place or slow response times detected. Please wait and try again later.',
  // OpenRouter free-tier daily body passthrough
  '[API Error: Rate limit exceeded: limit_rpd/deepseek-r1-0528:free (Status: 429)]',
];

for (const banner of LIMIT_VARIANTS) {
  test(`detects limit: "${banner.slice(0, 55)}…"`, () => {
    const pane = `⏺ working on it\n\n${banner}\n\n› Type your message\n`;
    const d = detectLimit(pane, 12, qwen.patterns);
    assert.equal(d.hit, true);
    assert.ok(d.resetLine, 'resetLine should be captured');
  });
}

test('Coding Plan quota classifies as 5h window', () => {
  const d = detectLimit('✕ Allocated quota exceeded, please increase your quota limit.\n› \n', 12, qwen.patterns);
  assert.equal(d.limitType, '5h');
});

test('transient retry banner is NOT a limit but IS busy + overload', () => {
  const pane = '↻ Retrying in 5s… (attempt 2/5)\n';
  assert.equal(detectLimit(pane, 12, qwen.patterns).hit, false);
  assert.equal(isBusy(pane, qwen.patterns.busyPatterns), true);
  assert.ok(overloadMatch(pane, qwen.patterns.overloadPatterns));
});

test('discontinued-tier message is terminal, not a limit', () => {
  const pane = '✕ Qwen OAuth free tier has been discontinued as of 2026-04-15.\n\nTo continue using Qwen Code, try one of these alternatives:\n  - OpenRouter: https://openrouter.ai/docs/quickstart\n';
  assert.equal(detectLimit(pane, 12, qwen.patterns).hit, false);
  assert.ok(overloadMatch(pane, qwen.patterns.terminalPatterns));
});

test('agent prose about rate limits is not a limit stop', () => {
  const pane = '⏺ The docs mention the API enforces a rate limit of 60 requests\n  per minute, and quota exceeded errors should be retried.\n\n› \n';
  assert.equal(detectLimit(pane, 12, qwen.patterns).hit, false);
});

// --- resume invocation ---

test('qwen resume args (message typed into TUI)', () => {
  const withId = qwen.resumeArgs('0199a213-81c0-7800-8aa1-bbab2a035a53', 'continue');
  assert.deepEqual(withId.args, ['--resume', '0199a213-81c0-7800-8aa1-bbab2a035a53']);
  assert.equal(withId.messageViaPane, true);
  const noId = qwen.resumeArgs(null, 'continue');
  assert.deepEqual(noId.args, ['--continue']);
});

test('qwen foreground command check', () => {
  assert.equal(qwen.isForegroundCommand('qwen'), true);
  assert.equal(qwen.isForegroundCommand('node'), true);
  assert.equal(qwen.isForegroundCommand('zsh'), false);
});

// --- latestSessionId via runtime.json sidecars ---

test('sanitizeCwd matches qwen-code scheme (every non-alphanumeric → dash)', () => {
  assert.equal(sanitizeCwd('/Users/me/my_proj.x'), '-Users-me-my-proj-x');
});

test('latestSessionId picks the newest runtime.json matching the workdir', () => {
  const cwd = '/tmp/proj a';
  const chats = join(DIR, 'projects', sanitizeCwd(cwd), 'chats');
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(chats, 'aaaaaaaa-1111-4111-8111-111111111111.runtime.json'),
    JSON.stringify({ schema_version: 1, pid: 999999, session_id: 'aaaaaaaa-1111-4111-8111-111111111111', work_dir: cwd, started_at: 1000 }));
  writeFileSync(join(chats, 'bbbbbbbb-2222-4222-8222-222222222222.runtime.json'),
    JSON.stringify({ schema_version: 1, pid: 999998, session_id: 'bbbbbbbb-2222-4222-8222-222222222222', work_dir: cwd, started_at: 2000 }));
  writeFileSync(join(chats, 'cccccccc-3333-4333-8333-333333333333.runtime.json'),
    JSON.stringify({ schema_version: 1, pid: 999997, session_id: 'cccccccc-3333-4333-8333-333333333333', work_dir: '/somewhere/else', started_at: 3000 }));
  assert.equal(latestSessionId(cwd, null, DIR), 'bbbbbbbb-2222-4222-8222-222222222222');
});

test('latestSessionId falls back to newest chat jsonl when no sidecars', () => {
  const cwd = '/tmp/proj-b';
  const chats = join(DIR, 'projects', sanitizeCwd(cwd), 'chats');
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(chats, 'dddddddd-4444-4444-8444-444444444444.jsonl'), '{"sessionId":"d"}\n');
  assert.equal(latestSessionId(cwd, null, DIR), 'dddddddd-4444-4444-8444-444444444444');
});

test('latestSessionId returns null for unknown workdir', () => {
  assert.equal(latestSessionId('/nope/never', null, DIR), null);
});
