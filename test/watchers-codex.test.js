// Codex rollout-line parser: limit stops never reach rollout files as Error
// events (not persisted), but every turn writes token_count events carrying a
// rate_limits snapshot with used_percent + resets_at epochs. Fixture shapes
// captured from a real ~/.codex/sessions rollout.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRolloutLine, rolloutMeta } from '../src/watchers/codex.js';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-codex-watch-test-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

const TS = '2026-05-13T06:37:10.065Z';
const RESETS_PRIMARY = 1778672230;    // epoch seconds
const RESETS_SECONDARY = 1778674736;

function tokenCountLine(rateLimits) {
  return JSON.stringify({
    timestamp: TS,
    type: 'event_msg',
    payload: { type: 'token_count', info: null, rate_limits: rateLimits },
  });
}

function rateLimits(overrides = {}) {
  return {
    limit_id: 'codex',
    limit_name: null,
    primary: { used_percent: 1.0, window_minutes: 300, resets_at: RESETS_PRIMARY },
    secondary: { used_percent: 1.0, window_minutes: 10080, resets_at: RESETS_SECONDARY },
    credits: null,
    plan_type: 'plus',
    rate_limit_reached_type: null,
    ...overrides,
  };
}

test('healthy token_count (low usage, no reached type) → null', () => {
  assert.equal(parseRolloutLine(tokenCountLine(rateLimits())), null);
});

test('primary window exhausted → 5h limit with epoch reset', () => {
  const rec = parseRolloutLine(tokenCountLine(rateLimits({
    primary: { used_percent: 100, window_minutes: 300, resets_at: RESETS_PRIMARY },
  })));
  assert.ok(rec);
  assert.equal(rec.limitType, '5h');
  assert.equal(rec.resetAt, RESETS_PRIMARY * 1000);
  assert.equal(rec.timestampMs, Date.parse(TS));
});

test('secondary window exhausted → weekly limit', () => {
  const rec = parseRolloutLine(tokenCountLine(rateLimits({
    secondary: { used_percent: 100, window_minutes: 10080, resets_at: RESETS_SECONDARY },
  })));
  assert.ok(rec);
  assert.equal(rec.limitType, 'weekly');
  assert.equal(rec.resetAt, RESETS_SECONDARY * 1000);
});

test('both windows exhausted → the later reset binds (weekly)', () => {
  const rec = parseRolloutLine(tokenCountLine(rateLimits({
    primary: { used_percent: 100, window_minutes: 300, resets_at: RESETS_PRIMARY },
    secondary: { used_percent: 100, window_minutes: 10080, resets_at: RESETS_SECONDARY },
  })));
  assert.ok(rec);
  assert.equal(rec.resetAt, RESETS_SECONDARY * 1000);
  assert.equal(rec.limitType, 'weekly');
});

test('rate_limit_reached_type set → hit even below 100%', () => {
  const rec = parseRolloutLine(tokenCountLine(rateLimits({
    primary: { used_percent: 99.2, window_minutes: 300, resets_at: RESETS_PRIMARY },
    rate_limit_reached_type: 'primary',
  })));
  assert.ok(rec);
  assert.equal(rec.limitType, '5h');
  assert.equal(rec.resetAt, RESETS_PRIMARY * 1000);
});

test('non-token_count and malformed lines → null', () => {
  assert.equal(parseRolloutLine(JSON.stringify({ timestamp: TS, type: 'response_item', payload: {} })), null);
  assert.equal(parseRolloutLine(JSON.stringify({ timestamp: TS, type: 'event_msg', payload: { type: 'agent_message' } })), null);
  assert.equal(parseRolloutLine('{{ not json'), null);
  assert.equal(parseRolloutLine(''), null);
  // token_count without rate_limits (older builds)
  assert.equal(parseRolloutLine(JSON.stringify({ timestamp: TS, type: 'event_msg', payload: { type: 'token_count', info: null } })), null);
});

test('rolloutMeta reads sessionId/cwd/originator from the session_meta head', () => {
  const id = '019e2001-9214-74e0-9afb-f0ec217b794d';
  const path = join(DIR, `rollout-2026-05-13T11-53-54-${id}.jsonl`);
  const meta = {
    timestamp: TS,
    type: 'session_meta',
    payload: { id, timestamp: TS, cwd: '/tmp/proj-codex', originator: 'codex-tui', cli_version: '0.130.0', source: 'cli' },
  };
  writeFileSync(path, JSON.stringify(meta) + '\n' + tokenCountLine(rateLimits()) + '\n');
  const info = rolloutMeta(path);
  assert.equal(info.sessionId, id);
  assert.equal(info.cwd, '/tmp/proj-codex');
  assert.equal(info.originator, 'codex-tui');
});

test('rolloutMeta falls back to the filename uuid when the head is unreadable', () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const path = join(DIR, `rollout-2026-05-13T11-53-54-${id}.jsonl`);
  writeFileSync(path, 'garbage not json\n');
  const info = rolloutMeta(path);
  assert.equal(info.sessionId, id);
  assert.equal(info.cwd, null);
});
