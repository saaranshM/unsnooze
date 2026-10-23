import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-kimi-quota-'));
process.env.UNSNOOZE_STATE_DIR = join(DIR, 'state');
process.env.UNSNOOZE_KIMI_CODE_DIR = join(DIR, 'code');
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_VERIFY_DELAY_MS = '0';
const { createQuotaReader, parseQuotaReset } = await import('../src/agents/kimi-quota.js');
const { refreshProviderReset, runResumer } = await import('../src/resumer.js');
const { getAgent } = await import('../src/agents/index.js');
const { upsertSession, readState, setStatus } = await import('../src/state.js');
after(() => rmSync(DIR, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 9, 23, 21, 56);
const RESET = NOW + 4 * 60_000;
const iso = n => new Date(n).toISOString();
const entry = (used_ratio, reset_time = iso(RESET)) => ({ used_ratio, reset_time });
const payload = extra => ({ usages: { limit_5h: entry(1), limit_month_total: entry(0.33), ...extra } });
const SID = 'session_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const rec = { agent: 'kimi', sessionId: SID, limitType: '5h' };

test('uses the absolute reset from the API, not a fresh relative countdown', () => {
  const first = parseQuotaReset(payload(), { now: NOW });
  const later = parseQuotaReset(payload(), { now: NOW + 60000 });
  assert.equal(first.resetAt, RESET);
  assert.equal(later.resetAt, RESET);
  assert.equal(first.available, false);
});

test('available quota wakes now even when the API names the next window reset', () => {
  const result = parseQuotaReset(payload({ limit_5h: entry(0, iso(NOW + 5 * 3600000)) }), { now: NOW });
  assert.equal(result.available, true);
  assert.equal(result.resetAt, NOW);
});

test('all exhausted windows must reset; monthly exhaustion cannot be bypassed by a 5h reset', () => {
  const monthly = NOW + 7 * 86400000;
  const result = parseQuotaReset(payload({ limit_month_total: entry('1', iso(monthly)) }), { now: NOW });
  assert.equal(result.resetAt, monthly);
  assert.equal(result.limitType, 'monthly');
  assert.equal(result.available, false);
});

test('missing, malformed, or stale quota evidence never authorizes a wake', () => {
  for (const p of [null, {}, { usages: {} }, { usages: { limit_month_total: entry(0) } },
    payload({ limit_5h: entry(null) }), payload({ limit_5h: entry('') }),
    payload({ limit_5h: entry('not a ratio') }), payload({ limit_5h: entry(1, 'invalid') }),
    payload({ limit_5h: entry(1, iso(NOW - 1000)) })]) {
    assert.equal(parseQuotaReset(p, { now: NOW }), null);
  }
});

let n = 0;
function config({ base = 'https://api.kimi.ai/coding/v1', key = 'oauth/kimi-code-env-0123456789abcdef', provider = 'managed:kimi-code', storage = 'file' } = {}) {
  const root = join(DIR, `account-${n++}`);
  mkdirSync(join(root, 'credentials'), { recursive: true });
  writeFileSync(join(root, 'config.toml'), `[providers."managed:kimi-code"]\nbase_url = "${base}"\n[providers."managed:kimi-code".oauth]\nkey = "${key}"\nstorage = "${storage}"\n[models."kimi-code/test"]\nprovider = "${provider}"\n`);
  writeFileSync(join(root, 'credentials', 'kimi-code-env-0123456789abcdef.json'), JSON.stringify({ access_token: 'fixture', expires_at: NOW / 1000 + 3600 }));
  return { root, modelAlias: 'kimi-code/test', now: NOW };
}

test('reads the configured official region and credential slot; blocks redirects and bounds requests', async () => {
  const opts = config();
  const calls = [];
  const reader = createQuotaReader({ fetcher: async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => payload() };
  } });
  assert.equal((await reader(rec, opts)).resetAt, RESET);
  assert.equal(calls[0].url, 'https://api.kimi.ai/coding/v1/usages');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  await reader(rec, { ...opts, now: NOW + 1000 });
  assert.equal(calls.length, 1, 'share account quota during the polling interval');
  await reader(rec, { ...opts, now: NOW + 31000 });
  assert.equal(calls.length, 2);
});

test('never sends a token to custom endpoints, path traversal, keyring or unrelated providers', async () => {
  let calls = 0;
  const reader = createQuotaReader({ fetcher: async () => { calls++; throw new Error('unexpected request'); } });
  for (const options of [{ base: 'https://example.com/coding/v1' }, { base: 'http://api.kimi.ai/coding/v1' },
    { key: 'oauth/../../other' }, { provider: 'another-provider' }, { storage: 'keyring' }]) {
    assert.equal(await reader(rec, config(options)), null);
  }
  assert.equal(await reader({ ...rec, sessionId: 'legacy-id' }, config()), null);
  assert.equal(calls, 0);
});

test('network/auth/JSON failures preserve fallback rather than throwing or leaking response text', async () => {
  for (const fetcher of [async () => { throw new Error('private response'); },
    async () => ({ ok: false, status: 401 }),
    async () => ({ ok: true, json: async () => { throw new Error('private JSON'); } })]) {
    assert.equal(await createQuotaReader({ fetcher })(rec, config()), null);
  }
});

test('provider refresh upgrades a not-yet-due fallback without bypassing normal guards or storing credentials', async () => {
  upsertSession({ ...rec, status: 'stopped', detectedAt: NOW - 1000, bannerAt: NOW - 1000,
    resetSource: 'fallback', resetAt: NOW + 40 * 60000, workspaceHold: true });
  const before = readState().sessions[SID];
  assert.equal(await refreshProviderReset(before, { now: NOW, marginMs: 60000,
    reader: async () => parseQuotaReset(payload(), { now: NOW }) }), true);
  const changed = readState().sessions[SID];
  assert.equal(changed.resetAt, RESET + 60000);
  assert.equal(changed.quotaResetAt, RESET);
  assert.equal(changed.resetSource, 'absolute');
  assert.equal(changed.workspaceHold, true);
  assert.equal(changed.manual, undefined);
  assert.equal(JSON.stringify(changed).includes('fixture'), false);
  assert.equal(await refreshProviderReset(changed, { now: RESET + 1000,
    reader: async () => ({ available: true, resetAt: RESET + 1000, observedAt: RESET + 1000 }) }), true);
  assert.equal(readState().sessions[SID].resetAt, RESET + 1000);
});

test('an in-flight quota response cannot revive a cancelled episode or undo manual resume', async () => {
  const before = readState().sessions[SID];
  const reader = async () => { setStatus(SID, 'cancelled'); return { available: true, resetAt: NOW }; };
  assert.equal(await refreshProviderReset(before, { reader, now: NOW }), false);
  assert.equal(readState().sessions[SID].status, 'cancelled');
  let queried = false;
  assert.equal(await refreshProviderReset({ ...before, manual: true }, { reader: async () => { queried = true; } }), false);
  assert.equal(queried, false);
});

test('the scheduler queries quota and wakes available allowance before the old fallback probe is due', async () => {
  const agent = getAgent('kimi');
  const original = agent.quotaReset;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  const key = 'quota-scheduler-fixture';
  const sent = [];
  let queries = 0;
  const at = Date.now();
  upsertSession({ agent: 'kimi', sessionId: key, cwd: DIR, pane: '%quota', mux: 'tmux', paneOwner: null,
    status: 'stopped', detectedAt: at, resetAt: at + 3600000, resetSource: 'fallback', limitType: '5h' });
  agent.quotaReset = async () => { queries++; return { available: true, resetAt: Date.now() }; };
  const mux = { paneAlive: async () => true, capturePane: async () => '> ', paneCurrentCommand: async () => 'kimi',
    sendText: async (pane, message) => { sent.push({ pane, message }); controller.abort(); } };
  try {
    await runResumer({ resolveMux: () => mux, signal: controller.signal, pollInterval: 10, versionSkewed: () => false });
    assert.equal(queries, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].pane, '%quota');
    assert.equal(readState().sessions[key].resetSource, 'absolute');
    assert.equal(readState().sessions[key].manual, undefined);
  } finally {
    clearTimeout(timer);
    agent.quotaReset = original;
  }
});
