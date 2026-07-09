import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAgent, listAgents } from '../src/agents/index.js';
import { detectLimit, isBusy } from '../src/patterns.js';

test('getAgent resolves claude and falls back to claude for unknown/missing ids', () => {
  assert.equal(getAgent('claude').id, 'claude');
  assert.equal(getAgent(undefined).id, 'claude');
  assert.equal(getAgent('no-such-cli').id, 'claude');
});

test('listAgents includes claude', () => {
  assert.ok(listAgents().some(a => a.id === 'claude'));
});

test('claude adapter: resume args', () => {
  const claude = getAgent('claude');
  const withId = claude.resumeArgs('abc-123', 'go on');
  assert.deepEqual(withId.args, ['--resume', 'abc-123']);
  assert.equal(withId.messageViaPane, true);
  const noId = claude.resumeArgs(null, 'go on');
  assert.deepEqual(noId.args, ['-c']);
});

test('claude adapter: foreground command check', () => {
  const claude = getAgent('claude');
  assert.equal(claude.isForegroundCommand('claude'), true);
  assert.equal(claude.isForegroundCommand('node'), true);
  assert.equal(claude.isForegroundCommand('vim'), false);
});

test('claude adapter: pattern sets drive the shared engine', () => {
  const claude = getAgent('claude');
  const banner = [
    '⚠ You have hit your 5-hour limit',
    '· resets 3pm (UTC)',
    '',
  ].join('\n');
  const d = detectLimit(banner, 12, claude.patterns);
  assert.equal(d.hit, true);
  assert.equal(d.limitType, '5h');
  assert.equal(isBusy('✻ Cogitating… (esc to interrupt)', claude.patterns.busyPatterns), true);
});
