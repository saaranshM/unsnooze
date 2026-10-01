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

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

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

test('detects Antigravity "Individual quota reached" with compact 5h countdown', () => {
  const pane = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h52m46s.\nError ID: 5786f748-3cd2-42e4-9a58-47ca4cdf2ee6-1\n> \n';
  const d = detectLimit(pane, 12, agy.patterns);
  assert.equal(d.hit, true);
  assert.equal(d.limitType, '5h');
  const p = parseResetTime(d.resetLine);
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, (2 * 3600 + 52 * 60 + 46) * 1000);
});

test('reads a soft-wrapped Antigravity quota banner across lines', () => {
  // Test wrap between "Resets" and "in", and wrap between "in" and duration
  const wrappedResetsIn = [
    '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets',
    'in 2h52m46s.',
    'Error ID: 5786f748-3cd2-42e4-9a58-47ca4cdf2ee6-1',
    '> ',
  ].join('\n');
  const d1 = detectLimit(wrappedResetsIn, 12, agy.patterns);
  assert.equal(d1.hit, true);
  assert.equal(d1.limitType, '5h');
  const p1 = parseResetTime(d1.resetLine);
  assert.equal(p1.waitMs, (2 * 3600 + 52 * 60 + 46) * 1000);

  const wrappedAfterIn = [
    '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in',
    '2h52m46s.',
    'Error ID: 5786f748-3cd2-42e4-9a58-47ca4cdf2ee6-1',
    '> ',
  ].join('\n');
  const d2 = detectLimit(wrappedAfterIn, 12, agy.patterns);
  assert.equal(d2.hit, true);
  assert.equal(d2.limitType, '5h');
  const p2 = parseResetTime(d2.resetLine);
  assert.equal(p2.waitMs, (2 * 3600 + 52 * 60 + 46) * 1000);
});

test('sub-hour and second-scale resets stay a 5h-window stop', () => {
  const paneMin = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 45m10s.\n> \n';
  const dMin = detectLimit(paneMin, 12, agy.patterns);
  assert.equal(dMin.hit, true);
  assert.equal(dMin.limitType, '5h');
  assert.equal(parseResetTime(dMin.resetLine).waitMs, (45 * 60 + 10) * 1000);

  const paneSec = '⚠ Individual quota reached. Resets in 30s.\n> \n';
  const dSec = detectLimit(paneSec, 12, agy.patterns);
  assert.equal(dSec.hit, true);
  assert.equal(dSec.limitType, '5h');
  assert.equal(parseResetTime(dSec.resetLine).waitMs, 30 * 1000);
});

test('compact multi-day reset is detected as weekly', () => {
  const pane = '⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 6d18h.\n> \n';
  const d = detectLimit(pane, 12, agy.patterns);
  assert.equal(d.hit, true);
  assert.equal(d.limitType, 'weekly');
  assert.equal(parseResetTime(d.resetLine).waitMs, (6 * 24 + 18) * 3600 * 1000);
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

test('latestSessionId returns null when multiple recent sessions exist for the workspace', () => {
  const now = 1790000000000;
  writeFileSync(join(DIR, 'history.jsonl'), [
    JSON.stringify({ conversation_id: 'conv-1', cwd: '/tmp/proj-agy', timestamp: now - 1000 }),
    JSON.stringify({ conversation_id: 'conv-2', cwd: '/tmp/proj-agy', timestamp: now - 500 }),
  ].join('\n') + '\n');
  // With aroundTs supplied, multiple recent sessions are ambiguous: null
  assert.equal(latestSessionId('/tmp/proj-agy', now, DIR), null);
  // Without aroundTs, it returns the newest session: conv-2
  assert.equal(latestSessionId('/tmp/proj-agy', null, DIR), 'conv-2');
});

test('latestSessionId falls back to latest id when history entries have no timestamp', () => {
  const now = 1790000000000;
  writeFileSync(join(DIR, 'history.jsonl'), [
    JSON.stringify({ conversation_id: 'conv-old', cwd: '/tmp/proj-agy' }),
    JSON.stringify({ conversation_id: 'conv-new', cwd: '/tmp/proj-agy' }),
  ].join('\n') + '\n');
  assert.equal(latestSessionId('/tmp/proj-agy', now, DIR), 'conv-new');
});

test('resetPatterns does not match arbitrary lines containing "reset" (e.g. git reset)', () => {
  const gitResetLines = [
    'git reset --hard HEAD',
    'git reset',
    'Reset branch to HEAD',
  ];
  for (const line of gitResetLines) {
    assert.equal(
      agy.patterns.resetPatterns.some(p => p.test(line)),
      false,
      `line "${line}" should not match resetPatterns`
    );
  }
});

// --- no history-derived banner anchor ---

test('agy exposes no latestBannerAt: prompt timestamps must not anchor countdowns', () => {
  // history.jsonl only holds prompts; using its newest entry as the banner time
  // would fire "Resets in 3h" hours early.
  assert.equal(agy.latestBannerAt, undefined);
});
