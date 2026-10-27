// Read the same managed-account usage endpoint as Kimi Code. Never refresh or
// write its credentials; never persist a bearer token or an API response body.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { codeDir, readCodeState } from './kimi-code.js';

const ENDPOINTS = new Set(['https://api.kimi.com/coding/v1', 'https://api.kimi.ai/coding/v1']);
const WINDOWS = { limit_5h: '5h', limit_7d: 'weekly', limit_month_total: 'monthly', limit_month_code: 'monthly' };

export function parseQuotaReset(payload, { now = Date.now(), limitType = '5h' } = {}) {
  const usages = payload?.usages;
  if (!usages || typeof usages !== 'object') return null;
  const entries = [];
  for (const [key, type] of Object.entries(WINDOWS)) {
    if (usages[key] == null) continue;
    const raw = usages[key].used_ratio;
    if ((typeof raw !== 'number' && typeof raw !== 'string') || raw === '') return null;
    const ratio = Number(raw);
    if (!Number.isFinite(ratio) || ratio < 0) return null;
    const resetAt = Date.parse(usages[key].reset_time);
    entries.push({ key, type, ratio, resetAt });
  }
  // An empty/partial payload must not be interpreted as available allowance.
  if (!entries.some(e => e.type === limitType)) return null;
  const exhausted = entries.filter(e => e.ratio >= 1);
  if (!exhausted.length) return { available: true, resetAt: now, limitType, observedAt: now };
  // Every depleted window matters: a five-hour reset cannot clear a monthly
  // cap. Invalid or already-past timestamps with still-exhausted allowance
  // are inconclusive, not permission to wake immediately.
  if (exhausted.some(e => !Number.isFinite(e.resetAt) || e.resetAt <= now)) return null;
  const last = exhausted.reduce((a, b) => a.resetAt >= b.resetAt ? a : b);
  return { available: false, resetAt: last.resetAt, limitType: last.type, observedAt: now };
}

export function createQuotaReader({ fetcher = globalThis.fetch, ttlMs = 30_000 } = {}) {
  const cache = new Map();
  return async function quotaReset(rec, { root = codeDir(), now = Date.now(),
    modelAlias = readCodeState({ ...rec, root })?.modelAlias,
  } = {}) {
    if (!rec?.sessionId?.startsWith('session_') || !modelAlias) return null;
    try {
      const config = parse(readFileSync(join(root, 'config.toml'), 'utf8'));
      if (config.models?.[modelAlias]?.provider !== 'managed:kimi-code') return null;
      const provider = config.providers?.['managed:kimi-code'];
      const base = String(provider?.base_url || '').replace(/\/+$/, '');
      // Never send a saved credential to a custom URL, redirect, or a guessed
      // regional endpoint. The persisted provider chooses the account host.
      if (!ENDPOINTS.has(base) || provider.oauth?.storage !== 'file') return null;
      const key = provider.oauth.key?.match(/^oauth\/(kimi-code(?:-env-[a-f0-9]{16})?)$/)?.[1];
      if (!key) return null;
      const cacheKey = `${root}|${base}|${key}`;
      const cached = cache.get(cacheKey);
      if (cached && now - cached.at < ttlMs) {
        return cached.payload ? parseQuotaReset(cached.payload, { now, limitType: rec.limitType }) : null;
      }
      const token = JSON.parse(readFileSync(join(root, 'credentials', `${key}.json`), 'utf8'));
      if (typeof token.access_token !== 'string' || !token.access_token) return null;
      if (token.expires_at != null && Number(token.expires_at) * 1000 <= now) return null;
      if (cache.size >= 32) cache.clear();
      cache.set(cacheKey, { at: now, payload: null }); // bound failures too
      const response = await fetcher(`${base}/usages`, {
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json', 'User-Agent': 'unsnooze/1.20.1' },
        signal: AbortSignal.timeout(8_000), redirect: 'error',
      });
      if (!response.ok) return null;
      const data = await response.json();
      // Keep only numeric quota fields and reset timestamps, not arbitrary
      // account data returned by the server (balances, account identifiers).
      const payload = { usages: {} };
      for (const key of Object.keys(WINDOWS)) {
        if (data?.usages?.[key]) payload.usages[key] = {
          used_ratio: data.usages[key].used_ratio, reset_time: data.usages[key].reset_time,
        };
      }
      cache.set(cacheKey, { at: now, payload });
      return parseQuotaReset(payload, { now, limitType: rec.limitType });
    } catch { return null; } // unavailable auth/network/config: normal fallback
  };
}

export const quotaReset = createQuotaReader();
