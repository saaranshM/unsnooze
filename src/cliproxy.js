// CLIProxyAPI (router-for-me/CLIProxyAPI) in front of Codex.
//
// With Codex pointed at the proxy (model_providers.<x>.base_url), one Codex
// account running dry is invisible: the proxy just routes to the next one.
// Codex only stops once EVERY account is spent, and then it never sees an
// OpenAI usage-limit banner — the proxy answers 429 with its own body
//   {"error":{"code":"model_cooldown","message":"All credentials for model
//    gpt-5 are cooling down …","reset_seconds":…}}
// which Codex retries and finally renders as
//   ■ exceeded retry limit, last status: 429 Too Many Requests, request id: …
// Stock unsnooze files that under transient overload. With cliproxyUrl set,
// the codex adapter treats it as a limit stop (agents/codex.js), and this
// module decides WHEN to wake it: the moment any Codex account in the proxy
// has quota again — not when the account that happened to fail last resets.
//
// Per account, two sources, read through the proxy's management API:
//   GET  /v0/management/auth-files  — the proxy's own routing state (cooldown,
//        next_retry_after, disabled) for every credential;
//   POST /v0/management/api-call    — the proxy calls ChatGPT's
//        /backend-api/wham/usage with that account's token ($TOKEN$), which is
//        the authoritative 5h/weekly window state and reset time. The token
//        never leaves the proxy.
// An account is usable when the upstream says so. If the proxy still has it
// cooling down anyway (its cooldown outlived the window), it is cleared with
// POST /v0/management/reset-quota (cliproxyResetStale) so the woken session is
// actually routed to it.

import { getConfig } from './settings.js';
import { readState, setStatus } from './state.js';
import { RESET_MARGIN_MS, PROBE_INTERVAL_MS } from './config.js';
import { makeLogger } from './logger.js';

const log = makeLogger('cliproxy');

export const WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const REQUEST_TIMEOUT_MS = 15_000;
const POOL_TTL_MS = 60_000;
// A window counts as spent from 99% (the server reports fractions) — the same
// line watchers/codex.js draws.
const SPENT_PERCENT = 99;

export function cliproxyEnabled() {
  return !!String(getConfig('cliproxyUrl') || '').trim();
}

function baseUrl() {
  return String(getConfig('cliproxyUrl') || '').trim().replace(/\/+$/, '');
}

async function mgmt(path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const key = String(getConfig('cliproxyKey') || '');
  const res = await fetchImpl(`${baseUrl()}/v0/management${path}`, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${method} ${path}: not JSON`); }
}

const pick = (obj, ...names) => {
  for (const n of names) if (obj && obj[n] != null) return obj[n];
  return undefined;
};

// wham/usage → { available, resetAt (ms) | null }, or null when the body is
// not a usage snapshot. resetAt is when the account is usable again: the
// LATEST reset among spent windows (waking at an earlier one would hit the
// other limit straight away).
export function parseWhamUsage(body, now = Date.now()) {
  let data = body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return null; }
  }
  const rl = pick(data, 'rate_limit', 'rateLimit');
  if (!rl || typeof rl !== 'object') return null;
  const windows = [pick(rl, 'primary_window', 'primary'), pick(rl, 'secondary_window', 'secondary')]
    .filter(w => w && typeof w === 'object')
    .map(w => {
      const used = Number(pick(w, 'used_percent', 'usedPercent'));
      const at = Number(pick(w, 'reset_at', 'resetAt'));
      const after = Number(pick(w, 'reset_after_seconds', 'resetAfterSeconds'));
      const resetAt = at > 0 ? at * 1000 : (after >= 0 ? now + after * 1000 : null);
      return { used: Number.isFinite(used) ? used : 0, resetAt };
    });
  const spent = windows.filter(w => w.used >= SPENT_PERCENT);
  const blocked = pick(rl, 'allowed') === false || pick(rl, 'limit_reached', 'limitReached') === true
    || spent.length > 0;
  if (!blocked) return { available: true, resetAt: null };
  // limit_reached with no window at 99%+: the one nearest exhaustion governs.
  const governing = spent.length ? spent
    : windows.length ? [windows.reduce((a, b) => (b.used > a.used ? b : a))] : [];
  const times = governing.map(w => w.resetAt).filter(t => Number.isFinite(t) && t > 0);
  return { available: false, resetAt: times.length ? Math.max(...times) : null };
}

const isCodex = f => String(f?.provider || f?.type || '').toLowerCase() === 'codex';

function proxyCooldown(file, now) {
  const next = file?.next_retry_after ? Date.parse(file.next_retry_after) : NaN;
  return {
    cooling: !!file?.unavailable && Number.isFinite(next) && next > now,
    // unavailable with no retry time = a persistent failure (expired token,
    // 401) that no amount of waiting clears.
    broken: !!file?.unavailable && !Number.isFinite(next),
    next: Number.isFinite(next) && next > now ? next : null,
  };
}

// One account's verdict from the proxy state plus (optional) upstream usage.
// → { name, available, resetAt, staleCooldown, source }
export function accountVerdict(file, usage, now = Date.now()) {
  const name = file.email || file.label || file.name || file.id;
  const proxy = proxyCooldown(file, now);
  if (usage) {
    if (usage.available) {
      // Upstream says go; the proxy disagreeing is a stale cooldown.
      return { name, available: !proxy.cooling, resetAt: proxy.cooling ? proxy.next : null,
        staleCooldown: proxy.cooling, source: 'upstream' };
    }
    return { name, available: false, resetAt: usage.resetAt ?? proxy.next, staleCooldown: false, source: 'upstream' };
  }
  if (proxy.broken) return { name, available: false, resetAt: null, staleCooldown: false, source: 'proxy' };
  return { name, available: !proxy.cooling, resetAt: proxy.next, staleCooldown: false, source: 'proxy' };
}

export function poolVerdict(accounts) {
  const available = accounts.filter(a => a.available);
  const waits = accounts.filter(a => !a.available && Number.isFinite(a.resetAt)).map(a => a.resetAt);
  return {
    accounts,
    available: available.length,
    total: accounts.length,
    nextResetAt: waits.length ? Math.min(...waits) : null,
  };
}

async function fetchUsage(file, { fetchImpl }) {
  const accountId = file?.id_token?.chatgpt_account_id;
  const resp = await mgmt('/api-call', {
    method: 'POST',
    fetchImpl,
    body: {
      auth_index: file.auth_index,
      method: 'GET',
      url: WHAM_USAGE_URL,
      header: {
        Authorization: 'Bearer $TOKEN$',
        'Content-Type': 'application/json',
        'User-Agent': 'codex_cli_rs/0.0.0 (unsnooze)',
        ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {}),
      },
    },
  });
  if (resp?.status_code !== 200) throw new Error(`wham/usage HTTP ${resp?.status_code}`);
  const usage = parseWhamUsage(resp.body);
  if (!usage) throw new Error('wham/usage: unrecognised body');
  return usage;
}

// Every enabled Codex account in the proxy, with a verdict. Throws when the
// proxy itself is unreachable — callers then leave records alone.
export async function fetchCodexPool({ fetchImpl = fetch, now = Date.now(), resetStale = getConfig('cliproxyResetStale') } = {}) {
  const list = await mgmt('/auth-files', { fetchImpl });
  const files = (Array.isArray(list?.files) ? list.files : []).filter(f => isCodex(f) && !f.disabled);
  const accounts = await Promise.all(files.map(async (file) => {
    let usage = null;
    try {
      usage = await fetchUsage(file, { fetchImpl });
    } catch (err) {
      log(`${file.name || file.id}: usage probe failed (${err.message}) — using proxy state`);
    }
    const v = accountVerdict(file, usage, now);
    if (v.staleCooldown && resetStale && file.auth_index) {
      try {
        await mgmt('/reset-quota', { method: 'POST', fetchImpl, body: { auth_index: file.auth_index } });
        log(`${v.name}: upstream has quota but proxy was cooling it down — cooldown cleared`);
        return { ...v, available: true, resetAt: null };
      } catch (err) {
        log(`${v.name}: reset-quota failed (${err.message})`);
      }
    }
    return v;
  }));
  return poolVerdict(accounts);
}

let cache = null;
export async function codexPool({ fetchImpl, now = Date.now(), force = false } = {}) {
  if (!force && cache && now - cache.at < POOL_TTL_MS) return cache.pool;
  const pool = await fetchCodexPool({ fetchImpl, now });
  cache = { at: now, pool };
  return pool;
}
export function _resetPoolCache() { cache = null; }

// Records the proxy decides for: stopped Codex usage-limit stops the resumer
// would wake on its own. Workspace walls (limitType 'model'), holds, and
// manual resume-now requests are left exactly as they are.
export function governedRecords(state = readState()) {
  return Object.values(state.sessions || {}).filter(s => s.status === 'stopped'
    && s.agent === 'codex' && s.limitType !== 'model' && !s.manual && !s.workspaceHold);
}

// When a governed record should wake, given the pool. `backoffMs(attempts)`
// keeps a failing wake from being retried every tick just because the pool
// looks open.
export function targetResetAt(rec, pool, now = Date.now(), { backoffMs = () => 0 } = {}) {
  if (pool.available > 0) {
    const notBefore = rec.attempts > 0 && rec.lastAttemptAt ? rec.lastAttemptAt + backoffMs(rec.attempts) : 0;
    return Math.max(now, notBefore);
  }
  if (Number.isFinite(pool.nextResetAt)) return pool.nextResetAt + RESET_MARGIN_MS;
  // Nothing in the pool will ever reset by itself (every account broken or
  // none configured): look again later rather than wake into a wall.
  return now + PROBE_INTERVAL_MS;
}

// One resumer tick: re-time every governed Codex stop from the proxy.
export async function reconcileCodexStops({ now = Date.now(), backoffMs, fetchImpl } = {}) {
  if (!cliproxyEnabled()) return null;
  const recs = governedRecords();
  if (recs.length === 0) return null;
  let pool;
  try {
    pool = await codexPool({ fetchImpl, now });
  } catch (err) {
    log(`proxy unreachable (${err.message}) — leaving Codex stops as scheduled`);
    return null;
  }
  for (const rec of recs) {
    const at = targetResetAt(rec, pool, now, { backoffMs });
    if (rec.resetSource === 'cliproxy' && Math.abs((rec.resetAt || 0) - at) < 30_000) continue;
    setStatus(rec.key, 'stopped', { resetAt: at, resetSource: 'cliproxy', probeCount: 0 },
      { expect: ['stopped'], expectCutoff: rec.bannerAt ?? rec.detectedAt });
    log(`${rec.key}: ${pool.available}/${pool.total} Codex accounts usable — wake ${at <= now ? 'now' : `at ${new Date(at).toISOString()}`}`);
  }
  return pool;
}

// `unsnooze cliproxy` — what the resumer would see right now.
export async function cmdCliproxy(_args = [], { fetchImpl = fetch, out = console.log } = {}) {
  if (!cliproxyEnabled()) {
    out('CLIProxyAPI integration is off. Turn it on with:\n'
      + '  unsnooze config set cliproxyUrl http://127.0.0.1:8317\n'
      + '  unsnooze config set cliproxyKey <management key>');
    return 1;
  }
  let pool;
  try {
    // Report only: never clear a proxy cooldown from a status command.
    pool = await fetchCodexPool({ fetchImpl, resetStale: false });
  } catch (err) {
    out(`CLIProxyAPI at ${baseUrl()} unreachable: ${err.message}`);
    return 1;
  }
  const when = t => (Number.isFinite(t) ? new Date(t).toLocaleString() : 'unknown');
  out(`CLIProxyAPI ${baseUrl()} — ${pool.available}/${pool.total} Codex accounts usable`);
  for (const a of pool.accounts) {
    const state = a.available ? 'usable'
      : a.staleCooldown ? `proxy cooldown until ${when(a.resetAt)} (upstream already has quota)`
        : `spent — resets ${when(a.resetAt)}`;
    out(`  ${a.name}: ${state}  [${a.source}]`);
  }
  if (pool.total && !pool.available) out(`Stopped Codex sessions wake at ${when(pool.nextResetAt)}.`);
  const waiting = governedRecords().length;
  if (waiting) out(`${waiting} stopped Codex session(s) governed by the proxy pool.`);
  return 0;
}
