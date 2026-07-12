// Antigravity CLI (agy) adapter: closed-source Go binary, so fixtures use the
// limit strings reported on Google's forums ("Model quota limit exceeded",
// "Refreshes in 6 days and 18 hours") — grok-bar experimental quality.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-agy-test-'));
process.env.UNSNOOZE_AGY_DIR = DIR;

const { default: agy, latestSessionId } = await import('../src/agents/agy.js');
const { getAgent } = await import('../src/agents/index.js');
const { detectLimit, overloadMatch } = await import('../src/patterns.js');
const { parseResetTime } = await import('../src/time-parser.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

test('agy is registered and experimental', () => {
  assert.equal(getAgent('agy').id, 'agy');
  assert.equal(agy.experimental, true);
});

// --- banner variants ---

test('detects "Model quota limit exceeded" with refresh countdown as weekly', () => {
  const pane = '⏺ working on it\n\nModel quota limit exceeded\nRefreshes in 6 days and 18 hours\n\n> \n';
  const d = detectLimit(pane, 12, agy.patterns);
  assert.equal(d.hit, true);
  assert.equal(d.limitType, 'weekly');
  const p = parseResetTime(d.resetLine);
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, (6 * 24 + 18) * 3_600_000);
});

test('hour-scale refresh stays a 5h-window stop (not weekly)', () => {
  const pane = 'Model quota limit exceeded\nRefreshes in 3 hours\n> \n';
  const d = detectLimit(pane, 12, agy.patterns);
  assert.equal(d.hit, true);
  assert.notEqual(d.limitType, 'weekly');
});

test('detects API-key-mode RESOURCE_EXHAUSTED', () => {
  const pane = 'Error: 429 RESOURCE_EXHAUSTED: quota exceeded for model gemini-3.1-pro\n> \n';
  assert.equal(detectLimit(pane, 12, agy.patterns).hit, true);
});

test('MODEL_CAPACITY_EXHAUSTED is provider capacity — overload, NOT a limit', () => {
  const pane = 'HTTP 503 MODEL_CAPACITY_EXHAUSTED on claude-opus-4-6\n';
  assert.equal(detectLimit(pane, 12, agy.patterns).hit, false);
  assert.ok(overloadMatch(pane, agy.patterns.overloadPatterns));
});

test('agent prose about quotas is not a limit stop', () => {
  const pane = '⏺ The importer should handle throttling by backing off when the\n  service reports heavy usage.\n\n> \n';
  assert.equal(detectLimit(pane, 12, agy.patterns).hit, false);
});

// --- resume invocation ---

test('agy resume args use --conversation=<id>, --continue without one', () => {
  const withId = agy.resumeArgs('conv-abc123', 'continue');
  assert.deepEqual(withId.args, ['--conversation=conv-abc123']);
  assert.equal(withId.messageViaPane, true);
  // Verified against agy --help: --continue resumes the most recent conversation.
  const noId = agy.resumeArgs(null, 'continue');
  assert.deepEqual(noId.args, ['--continue']);
});

test('agy foreground command check', () => {
  assert.equal(agy.isForegroundCommand('agy'), true);
  assert.equal(agy.isForegroundCommand('node'), true);
  assert.equal(agy.isForegroundCommand('zsh'), false);
});

// --- latestSessionId: tolerant tail of history.jsonl, null on any doubt ---

test('latestSessionId matches the newest history entry for the cwd', () => {
  writeFileSync(join(DIR, 'history.jsonl'), [
    JSON.stringify({ conversation_id: 'conv-old', cwd: '/tmp/proj-agy' }),
    JSON.stringify({ conversation_id: 'conv-other', cwd: '/somewhere/else' }),
    JSON.stringify({ conversation_id: 'conv-new', cwd: '/tmp/proj-agy' }),
  ].join('\n') + '\n');
  assert.equal(latestSessionId('/tmp/proj-agy', null, DIR), 'conv-new');
});

test('latestSessionId is null when nothing matches or the schema is foreign', () => {
  assert.equal(latestSessionId('/nope/never', null, DIR), null);
  writeFileSync(join(DIR, 'history.jsonl'), 'not json at all\n');
  assert.equal(latestSessionId('/tmp/proj-agy', null, DIR), null);
});
