// CLIProxyAPI in front of Codex: the proxy's "all credentials cooling down"
// 429 is a limit stop, and the stop wakes when ANY Codex account in the proxy
// pool has quota again — read through a faked management API.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-cliproxy-'));
process.env.UNSNOOZE_STATE_DIR = join(DIR, 'state');
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');
process.env.UNSNOOZE_CODEX_DIR = join(DIR, 'codex');
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_MULTIPLEXER = 'headless';
process.env.UNSNOOZE_CLIPROXY_URL = 'http://127.0.0.1:8317/';
process.env.UNSNOOZE_CLIPROXY_KEY = 'secret';

const cp = await import('../src/cliproxy.js');
const { patterns } = await import('../src/agents/codex.js');
const { detectLimit } = await import('../src/patterns.js');
const { readState, updateState } = await import('../src/state.js');
const { RESET_MARGIN_MS } = await import('../src/config.js');
after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const NOW = Date.parse('2026-10-02T12:00:00Z');
const sec = ms => Math.floor(ms / 1000);

function wham({ used = 10, reset = NOW + 3_600_000, weekly = 20, weeklyReset = NOW + 5 * 86_400_000, allowed, reached } = {}) {
  return JSON.stringify({
    plan_type: 'plus',
    rate_limit: {
      allowed: allowed ?? used < 100,
      limit_reached: reached ?? used >= 100,
      primary_window: { used_percent: used, limit_window_seconds: 18000, reset_at: sec(reset) },
      secondary_window: { used_percent: weekly, limit_window_seconds: 604800, reset_at: sec(weeklyReset) },
    },
  });
}

// files: auth-files entries; usage: auth_index → wham body (or status code).
function fakeProxy(files, usage, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    assert.equal(init.headers.Authorization, 'Bearer secret');
    const path = url.replace('http://127.0.0.1:8317/v0/management', '');
    const json = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });
    if (path === '/auth-files') return json({ files });
    if (path === '/api-call') {
      const req = JSON.parse(init.body);
      assert.equal(req.header.Authorization, 'Bearer $TOKEN$');
      const u = usage[req.auth_index];
      if (typeof u === 'number') return json({ status_code: u, body: '{}' });
      return json({ status_code: 200, body: u });
    }
    if (path === '/reset-quota') return json({ status: 'ok' });
    return json({ error: 'nope' }, 404);
  };
}

const acct = (i, extra = {}) => ({
  id: `codex-${i}.json`, auth_index: `idx${i}`, name: `codex-${i}.json`, provider: 'codex', type: 'codex',
  email: `a${i}@x`, disabled: false, unavailable: false, id_token: { chatgpt_account_id: `acc-${i}` }, ...extra,
});

test('proxy cooldown error is a codex limit stop when cliproxyUrl is set', () => {
  const pane = [
    '› fix the tests',
    '',
    '■ exceeded retry limit, last status: 429 Too Many Requests, request id: abc-123',
    '',
    '› Ask Codex to do anything',
  ].join('\n');
  const d = detectLimit(pane, 12, patterns);
  assert.equal(d.hit, true);
  const raw = '{"error":{"code":"model_cooldown","message":"All credentials for model gpt-5-codex are cooling down via provider codex"}}';
  assert.equal(detectLimit(raw, 0, patterns).hit, true);
});

test('parseWhamUsage: spent 5h window → reset at that window; spent both → latest', () => {
  assert.deepEqual(cp.parseWhamUsage(wham({ used: 40 }), NOW), { available: true, resetAt: null });
  const five = NOW + 2 * 3_600_000;
  assert.deepEqual(cp.parseWhamUsage(wham({ used: 100, reset: five }), NOW), { available: false, resetAt: sec(five) * 1000 });
  const week = NOW + 3 * 86_400_000;
  assert.equal(cp.parseWhamUsage(wham({ used: 100, reset: five, weekly: 100, weeklyReset: week }), NOW).resetAt, sec(week) * 1000);
  assert.equal(cp.parseWhamUsage('not json', NOW), null);
});

test('pool: next reset is the EARLIEST account to come back', async () => {
  const files = [acct(1), acct(2), acct(3, { disabled: true }), { ...acct(4), provider: 'claude', type: 'claude' }];
  const usage = {
    idx1: wham({ used: 100, reset: NOW + 4 * 3_600_000 }),
    idx2: wham({ used: 100, reset: NOW + 1 * 3_600_000 }),
  };
  const pool = await cp.fetchCodexPool({ fetchImpl: fakeProxy(files, usage), now: NOW });
  assert.equal(pool.total, 2);
  assert.equal(pool.available, 0);
  assert.equal(pool.nextResetAt, sec(NOW + 3_600_000) * 1000);
});

test('pool: stale proxy cooldown on an account upstream says is fine gets cleared', async () => {
  const calls = [];
  const files = [acct(1, { unavailable: true, next_retry_after: new Date(NOW + 3_600_000).toISOString() })];
  const pool = await cp.fetchCodexPool({ fetchImpl: fakeProxy(files, { idx1: wham({ used: 5 }) }, calls), now: NOW, resetStale: true });
  assert.equal(pool.available, 1);
  assert.ok(calls.some(c => c.url.endsWith('/reset-quota') && JSON.parse(c.init.body).auth_index === 'idx1'));
});

test('pool: usage probe failure falls back to the proxy cooldown', async () => {
  const next = NOW + 30 * 60_000;
  const files = [acct(1, { unavailable: true, next_retry_after: new Date(next).toISOString() })];
  const pool = await cp.fetchCodexPool({ fetchImpl: fakeProxy(files, { idx1: 401 }), now: NOW, resetStale: true });
  assert.equal(pool.available, 0);
  assert.equal(pool.nextResetAt, next);
});

test('targetResetAt: available → now (respecting retry backoff); spent → next reset + margin', () => {
  const open = { available: 1, total: 2, nextResetAt: null };
  assert.equal(cp.targetResetAt({ attempts: 0 }, open, NOW), NOW);
  assert.equal(cp.targetResetAt({ attempts: 2, lastAttemptAt: NOW - 1000 }, open, NOW, { backoffMs: () => 60_000 }), NOW + 59_000);
  const shut = { available: 0, total: 2, nextResetAt: NOW + 3_600_000 };
  assert.equal(cp.targetResetAt({}, shut, NOW), NOW + 3_600_000 + RESET_MARGIN_MS);
});

beforeEach(() => cp._resetPoolCache());

test('reconcileCodexStops re-times codex stops and leaves others alone', async () => {
  updateState(state => {
    state.sessions = {
      c1: { key: 'c1', agent: 'codex', status: 'stopped', limitType: 'unknown', resetAt: NOW + 5 * 3_600_000, resetSource: 'fallback', detectedAt: NOW - 1000 },
      c2: { key: 'c2', agent: 'codex', status: 'stopped', limitType: 'model', resetAt: NOW + 999, detectedAt: NOW - 1000 },
      k1: { key: 'k1', agent: 'claude', status: 'stopped', limitType: '5h', resetAt: NOW + 5 * 3_600_000, detectedAt: NOW - 1000 },
    };
    return state;
  });
  const files = [acct(1), acct(2)];
  // One account came back already → wake now.
  const usage = { idx1: wham({ used: 100, reset: NOW + 3_600_000 }), idx2: wham({ used: 30 }) };
  await cp.reconcileCodexStops({ now: NOW, fetchImpl: fakeProxy(files, usage) });
  const s = readState().sessions;
  assert.equal(s.c1.resetAt, NOW);
  assert.equal(s.c1.resetSource, 'cliproxy');
  assert.equal(s.c2.resetAt, NOW + 999);
  assert.equal(s.k1.resetAt, NOW + 5 * 3_600_000);
});
