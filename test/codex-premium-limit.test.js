import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-codex-premium-'));
process.env.UNSNOOZE_STATE_DIR = join(DIR, 'state');
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');
process.env.UNSNOOZE_CODEX_DIR = join(DIR, 'codex');
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_MULTIPLEXER = 'headless';
process.env.UNSNOOZE_AUTO_RESUME = 'true';

const { parseRolloutLines } = await import('../src/watchers/codex.js');
const { createWatcher, codexSource } = await import('../src/watcher.js');
const { readState } = await import('../src/state.js');
const { dueForDispatch } = await import('../src/resumer.js');
const { buildUsageReport, extractCodexUsage } = await import('../src/usage.js');
const { RESET_MARGIN_MS } = await import('../src/config.js');
after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

// Issue #20: the two consecutive snapshots at the enforced five-hour limit.
const BEFORE = Date.parse('2026-09-05T13:48:36.539Z');
const BLOCKED = Date.parse('2026-09-05T13:48:37.162Z');
const RESET = 1788631754;
function snapshot(rateLimits, at = BEFORE) {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', rate_limits: rateLimits } });
}
function normal(overrides = {}, at = BEFORE) {
  return snapshot({ limit_id: 'codex',
    primary: { used_percent: 99, window_minutes: 300, resets_at: RESET },
    secondary: { used_percent: 32, window_minutes: 10080, resets_at: 1788751350 },
    plan_type: 'plus', rate_limit_reached_type: null, ...overrides }, at);
}
function premium(overrides = {}, at = BLOCKED) {
  return snapshot({ limit_id: 'premium', primary: null, secondary: null,
    credits: { has_credits: false, unlimited: false, balance: '0' },
    plan_type: 'plus', rate_limit_reached_type: null, ...overrides }, at);
}

test('99% followed by empty premium records the known five-hour reset', () => {
  const hits = parseRolloutLines([normal(), premium()]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].limitType, '5h');
  assert.equal(hits[0].resetAt, RESET * 1000);
  assert.equal(hits[0].timestampMs, BLOCKED);
  // The empty bucket must not erase or reduce the latest exact usage.
  const report = buildUsageReport({ now: BLOCKED,
    codexSamples: [normal(), premium()].map(extractCodexUsage).filter(Boolean) });
  assert.equal(report.agents.find(a => a.agent === 'codex').windows[0].ladder.pct, 99);
});

test('99% alone, other buckets, stale context, and available credits do not infer stops', () => {
  const cases = [
    [normal()], [premium()],
    [normal({ limit_id: 'other' }), premium()],
    [normal({ primary: { used_percent: 98, window_minutes: 300, resets_at: RESET } }), premium()],
    [normal({ primary: { used_percent: 99, window_minutes: 10080, resets_at: RESET } }), premium()],
    [normal({ primary: { used_percent: 99, window_minutes: 300, resets_at: BEFORE / 1000 } }), premium()],
    [normal({}, BLOCKED - 60_001), premium()],
    [normal({}, BLOCKED + 1), premium()],
    [normal(), premium({ limit_id: 'other' })],
    [normal(), premium({ credits: { has_credits: true, unlimited: false, balance: '0' } })],
    [normal(), premium({ credits: { has_credits: false, unlimited: true, balance: '0' } })],
    [normal(), premium({ credits: { has_credits: false, unlimited: false, balance: '5' } })],
    [normal(), premium({ credits: { has_credits: false, unlimited: false, balance: null } })],
    [normal(), normal({ primary: { used_percent: 3, window_minutes: 300, resets_at: RESET } }), premium()],
    [normal(), snapshot({ limit_id: 'other', primary: null, secondary: null }), premium()],
  ];
  for (const lines of cases) assert.deepEqual(parseRolloutLines(lines), [], lines.join('\n'));
  const invalidTimestamp = JSON.parse(normal());
  invalidTimestamp.timestamp = 'invalid';
  assert.deepEqual(parseRolloutLines([JSON.stringify(invalidTimestamp), premium()]), []);
});

test('an exhausted weekly window still controls the later reset', () => {
  const hits = parseRolloutLines([normal({
    secondary: { used_percent: 100, window_minutes: 10080, resets_at: RESET + 86400 },
  }), premium()]);
  assert.equal(hits.at(-1).limitType, 'weekly');
  assert.equal(hits.at(-1).resetAt, (RESET + 86400) * 1000);
});

function setup(name) {
  const root = join(DIR, name);
  mkdirSync(root);
  const sessionId = name;
  const file = join(root, 'rollout-2026-09-05-12345678-1234-1234-1234-123456789abc.jsonl');
  const meta = JSON.stringify({ type: 'session_meta', payload: {
    id: sessionId, cwd: root, originator: 'codex_desktop',
  } }) + '\n';
  const makeWatcher = extra => createWatcher({
    sources: [codexSource({ roots: [root] })], offsetsPath: join(root, 'offsets.json'),
    now: () => BLOCKED, ...extra,
  });
  return { root, file, meta, makeWatcher, sessionId };
}

test('a stop across polls survives restart and becomes due only after reset plus margin', async () => {
  const { file, meta, makeWatcher, sessionId } = setup('restart');
  writeFileSync(file, meta);
  const watcher = makeWatcher();
  await watcher.tick();
  appendFileSync(file, normal() + '\n');
  assert.equal(await watcher.tick(), 0);
  const restarted = makeWatcher();
  appendFileSync(file, premium() + '\n');
  assert.equal(await restarted.tick(), 1);
  const record = Object.values(readState().sessions).find(s => s.sessionId === sessionId);
  assert.equal(record.status, 'stopped');
  assert.equal(record.origin, 'codex_desktop');
  assert.equal(record.resetAt, RESET * 1000 + RESET_MARGIN_MS);
  assert.equal(record.resetSource, 'absolute');
  assert.ok(!dueForDispatch(record.resetAt - 1).some(s => s.sessionId === sessionId));
  assert.ok(dueForDispatch(record.resetAt).some(s => s.sessionId === sessionId));
  appendFileSync(file, premium({}, BLOCKED + 1000) + '\n');
  assert.equal(await restarted.tick(), 0, 'repeated empty premium is not a new transition');
});

test('cold-start context can explain a new stop without replaying history', async () => {
  const { file, meta, makeWatcher } = setup('cold');
  writeFileSync(file, meta + normal() + '\n');
  const watcher = makeWatcher({ onStop: () => {} });
  assert.equal(await watcher.tick(), 0);
  appendFileSync(file, premium() + '\n');
  assert.equal(await watcher.tick(), 1);
  assert.equal(await watcher.tick(), 0);
});

test('context comes from the same file and never from after the batch offset', () => {
  const { file, meta } = setup('offset');
  writeFileSync(file, meta + premium() + '\n' + normal() + '\n');
  assert.deepEqual(parseRolloutLines([premium()], { path: file, offset: Buffer.byteLength(meta) }), []);
  assert.deepEqual(parseRolloutLines([premium()], { path: join(DIR, 'missing'), offset: 100 }), []);
  assert.deepEqual(parseRolloutLines([premium()], { path: file, offset: 0 }), []);
});
