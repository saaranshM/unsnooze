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

// --- unified ChatGPT app rollout format (codex-cli 0.144, verified live) ---
// New additive fields: limit_id, limit_name, credits, individual_limit,
// plan_type; secondary can be null. Wrapper structure is unchanged.

const UNIFIED_OK = JSON.stringify({
  timestamp: '2026-07-12T15:42:31.000Z', type: 'event_msg',
  payload: { type: 'token_count', rate_limits: {
    limit_id: 'codex', limit_name: null,
    primary: { used_percent: 5.0, window_minutes: 43200, resets_at: 1786462931 },
    secondary: null,
    credits: { has_credits: false, unlimited: false, balance: null },
    individual_limit: null, plan_type: 'go', rate_limit_reached_type: null,
  } },
});

const UNIFIED_EXHAUSTED = JSON.stringify({
  timestamp: '2026-07-12T15:42:31.000Z', type: 'event_msg',
  payload: { type: 'token_count', rate_limits: {
    limit_id: 'codex', limit_name: null,
    primary: { used_percent: 100, window_minutes: 43200, resets_at: 1786462931 },
    secondary: null,
    credits: { has_credits: false, unlimited: false, balance: null },
    individual_limit: null, plan_type: 'go', rate_limit_reached_type: 'primary',
  } },
});

test('unified-app snapshot below the limit is not a candidate', () => {
  assert.equal(parseRolloutLine(UNIFIED_OK), null);
});

test('unified-app exhausted window parses with epoch reset and long-window type', () => {
  const c = parseRolloutLine(UNIFIED_EXHAUSTED);
  assert.ok(c);
  assert.equal(c.resetAt, 1786462931 * 1000);
  assert.equal(c.limitType, 'weekly');   // 30-day window classifies as weekly-scale
});

test('unified-app session_meta head still yields id/cwd/originator', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-unified-meta-'));
  const p = join(dir, 'rollout-2026-07-12T21-12-08-019f56fe-3508-7f10-8bb2-5e1db403916f.jsonl');
  writeFileSync(p, JSON.stringify({
    timestamp: '2026-07-12T15:42:08.174Z', type: 'session_meta',
    payload: {
      session_id: '019f56fe-3508-7f10-8bb2-5e1db403916f', id: '019f56fe-3508-7f10-8bb2-5e1db403916f',
      cwd: '/tmp/probe', originator: 'codex_exec', cli_version: '0.144.0-alpha.4',
      source: 'exec', thread_source: 'user', model_provider: 'openai',
    },
  }) + '\n');
  const meta = rolloutMeta(p);
  assert.equal(meta.sessionId, '019f56fe-3508-7f10-8bb2-5e1db403916f');
  assert.equal(meta.cwd, '/tmp/probe');
  assert.equal(meta.originator, 'codex_exec');
});

test('non-window reached_type strings (workspace credit/limit variants) still bind the latest reset', () => {
  // Since the unified app, rate_limit_reached_type carries reason strings
  // (rate_limit_reached, workspace_owner_usage_limit_reached, …), not window
  // names — the parser must fall back to the latest-resetting window.
  const line = JSON.stringify({
    timestamp: '2026-07-12T15:42:31.000Z', type: 'event_msg',
    payload: { type: 'token_count', rate_limits: {
      limit_id: 'codex',
      primary: { used_percent: 97, window_minutes: 300, resets_at: 1786400000 },
      secondary: { used_percent: 99, window_minutes: 10080, resets_at: 1786462931 },
      plan_type: 'business', rate_limit_reached_type: 'workspace_owner_usage_limit_reached',
    } },
  });
  const c = parseRolloutLine(line);
  assert.ok(c, 'reached_type must bind even when no window shows 100%');
  assert.equal(c.resetAt, 1786462931 * 1000, 'latest reset governs');
  assert.equal(c.reachedType, 'workspace_owner_usage_limit_reached');
});
