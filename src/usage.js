// Account-wide usage burn forecast (1.13): weighted token sums, burn rate,
// time-to-limit ETA, calibration ladder, warn engine, and `unsnooze usage`.
// Positioning: prevention that feeds the resume loop — not a standalone analytics product.

import {
  mkdirSync, readFileSync, writeFileSync, renameSync, existsSync,
  readdirSync, statSync, openSync, readSync, closeSync,
} from 'node:fs';
import { join, dirname, basename, sep } from 'node:path';
import {
  CLAUDE_DIR, CODEX_DIR, USAGE_FILE, USAGE_ETA_WARN_MIN,
  USAGE_BURN_LOOKBACK_MS, USAGE_BURN_MIN_COVERAGE_MS, USAGE_IDLE_GAP_MS,
  USAGE_WINDOW_IDLE_MS, USAGE_CALIBRATION_RING, USAGE_CALIBRATION_MEDIAN_N,
  USAGE_STATUSLINE_DIR,
} from './config.js';
import { readState, updateState } from './state.js';
import { getConfig } from './settings.js';
import { ROLLOUT_RE } from './agents/codex.js';
import { shouldUseTui, formatUsageTui, bar as tuiBar } from './tui.js';
import { shouldUseDashboard, runDashboard } from './dashboard/run.js';

// ---------------------------------------------------------------------------
// Constants & pure math
// ---------------------------------------------------------------------------

export const TOKEN_WEIGHT_FORMULA_V = 1;
const CACHE_READ_WEIGHT = 0.1;
export const DEFAULT_USAGE_WARN_AT = [80, 95];

export function weightedTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const create = usage.cache_creation_input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0;
  return input + output + create + Math.round(read * CACHE_READ_WEIGHT);
}

export function modelPool(model) {
  if (model == null || model === '') return 'unknown';
  const m = String(model);
  if (m === '<synthetic>' || /synthetic/i.test(m)) return 'synthetic';
  if (/opus/i.test(m)) return 'opus';
  if (/sonnet/i.test(m)) return 'sonnet';
  if (/haiku/i.test(m)) return 'haiku';
  return 'other';
}

export function labelWindow(windowMinutes) {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return 'unknown';
  if (windowMinutes >= 40_000) return '30d';       // 43200 on Codex go plan
  if (windowMinutes >= 7 * 1440) return 'weekly';
  if (windowMinutes >= 1440) {
    const d = Math.round(windowMinutes / 1440);
    return d === 1 ? '1d' : `${d}d`;
  }
  if (windowMinutes >= 60) {
    const h = Math.round(windowMinutes / 60);
    return h === 1 ? '1h' : `${h}h`;
  }
  return `${windowMinutes}m`;
}

// Epoch boundary: values below 1e12 are seconds (Codex/statusline); transcripts use ms.
export function normalizeResetsAtMs(resetsAt) {
  if (resetsAt == null) return null;
  const n = Number(resetsAt);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

export function reconstructWindowStart(samples, {
  now = Date.now(),
  maxIdleMs = USAGE_WINDOW_IDLE_MS,
  resetAtMs = null,
  windowMs = 5 * 3_600_000,
} = {}) {
  if (Number.isFinite(resetAtMs) && Number.isFinite(windowMs) && windowMs > 0) {
    const anchored = resetAtMs - windowMs;
    // Only trust the anchor if it isn't far in the future relative to now
    // (stale resets_at after a window roll would pin a phantom start).
    if (anchored <= now && resetAtMs > now - 60_000) return anchored;
  }
  const sorted = [...samples]
    .filter(s => Number.isFinite(s.at) && s.at <= now)
    .sort((a, b) => b.at - a.at);
  if (sorted.length === 0) return now;
  let start = sorted[0].at;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i - 1].at - sorted[i].at;
    if (gap >= maxIdleMs) break;
    start = sorted[i].at;
  }
  return start;
}

// Active minutes over lookback: wall gaps > idleGapMs are not counted.
export function activeMinutes(timestamps, {
  now = Date.now(),
  lookbackMs = USAGE_BURN_LOOKBACK_MS,
  idleGapMs = USAGE_IDLE_GAP_MS,
} = {}) {
  const from = now - lookbackMs;
  const times = [...timestamps]
    .filter(t => Number.isFinite(t) && t >= from && t <= now)
    .sort((a, b) => a - b);
  if (times.length === 0) return 0;
  let ms = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > 0 && gap <= idleGapMs) ms += gap;
  }
  // Include a small tail from last event to now if still "active"
  const tail = now - times[times.length - 1];
  if (tail > 0 && tail <= idleGapMs) ms += tail;
  return ms / 60_000;
}

export function burnRate(samples, {
  now = Date.now(),
  lookbackMs = USAGE_BURN_LOOKBACK_MS,
  idleGapMs = USAGE_IDLE_GAP_MS,
  minCoverageMs = USAGE_BURN_MIN_COVERAGE_MS,
} = {}) {
  const from = now - lookbackMs;
  const inWin = samples.filter(s => Number.isFinite(s.at) && s.at >= from && s.at <= now);
  const totalWeighted = inWin.reduce((s, x) => s + (x.weighted || 0), 0);
  const mins = activeMinutes(inWin.map(s => s.at), { now, lookbackMs, idleGapMs });
  if (totalWeighted <= 0 || mins <= 0) {
    return { burnPerMin: 0, activeMin: mins, warmingUp: false, idle: true };
  }
  // Coverage: span of first→last active sample (not wall lookback)
  const times = inWin.map(s => s.at).sort((a, b) => a - b);
  const coverageMs = times.length >= 2 ? times[times.length - 1] - times[0] : 0;
  if (coverageMs < minCoverageMs && mins * 60_000 < minCoverageMs) {
    return { burnPerMin: null, activeMin: mins, warmingUp: true, idle: false };
  }
  return {
    burnPerMin: totalWeighted / mins,
    activeMin: mins,
    warmingUp: false,
    idle: false,
  };
}

// Band: pessimistic (low ceiling / high burn) ↔ optimistic (median ceiling / ewma burn).
export function etaBand({
  used,
  ceiling,
  burnCurrent,
  burnEwma,
  ceilingPess = null,
} = {}) {
  const burns = [burnCurrent, burnEwma].filter(b => Number.isFinite(b) && b > 0);
  if (burns.length === 0) return null;
  if (!Number.isFinite(used)) return null;
  const ceilings = [ceiling, ceilingPess].filter(c => Number.isFinite(c) && c > used);
  if (ceilings.length === 0 && Number.isFinite(ceiling) && ceiling > used) {
    ceilings.push(ceiling);
  }
  if (ceilings.length === 0) return null;

  const etas = [];
  for (const c of ceilings) {
    for (const b of burns) {
      etas.push(((c - used) / b) * 60_000);
    }
  }
  if (etas.length === 0) return null;
  etas.sort((a, b) => a - b);
  return { loMs: etas[0], hiMs: etas[etas.length - 1] };
}

export function ladderUsage({ exactPct = null, used = null, ceiling = null, stopCount = 0 } = {}) {
  if (Number.isFinite(exactPct)) {
    return {
      tier: 'exact',
      pct: Math.min(100, Math.max(0, exactPct)),
      used: Number.isFinite(used) ? used : null,
      ceiling: Number.isFinite(ceiling) ? ceiling : null,
      stopCount: stopCount || 0,
    };
  }
  if (Number.isFinite(used) && Number.isFinite(ceiling) && ceiling > 0 && stopCount > 0) {
    return {
      tier: 'calibrated',
      pct: Math.min(100, Math.max(0, (used / ceiling) * 100)),
      used,
      ceiling,
      stopCount,
    };
  }
  return {
    tier: 'estimated',
    pct: null,
    used: Number.isFinite(used) ? used : null,
    ceiling: null,
    stopCount: 0,
  };
}

export function fmtUsageProvenance(ladder) {
  if (!ladder) return '(estimated — calibrating, needs one observed limit stop)';
  if (ladder.tier === 'exact') return '(exact)';
  if (ladder.tier === 'calibrated') {
    const n = ladder.stopCount || 0;
    return `(calibrated from ${n} stop${n === 1 ? '' : 's'})`;
  }
  return '(estimated — calibrating, needs one observed limit stop)';
}

export function parseUsageWarnAt(raw) {
  if (raw == null || raw === '') return [...DEFAULT_USAGE_WARN_AT];
  const parts = String(raw).split(/[,\s]+/).map(s => parseFloat(s.trim())).filter(n =>
    Number.isFinite(n) && n > 0 && n <= 100);
  return parts.length > 0 ? parts.sort((a, b) => a - b) : [...DEFAULT_USAGE_WARN_AT];
}

export function warnKeysFor({ agent, limitType, resetsAt, threshold }) {
  return `${agent}:${limitType}:${resetsAt ?? 'none'}:${threshold}`;
}

// Debounce: must be crossed for ≥1 prior tick (pending) before firing.
export function shouldFireWarn(store, key, crossed) {
  store.fired ||= {};
  store.pending ||= {};
  if (!crossed) {
    delete store.pending[key];
    return false;
  }
  if (store.fired[key]) return false;
  if (!store.pending[key]) {
    store.pending[key] = Date.now();
    return false;
  }
  return true;
}

export function recordWarnFired(store, key) {
  store.fired ||= {};
  store.fired[key] = Date.now();
  delete store.pending?.[key];
}

// Keys embed resets_at, so every expired window leaves a dead entry behind.
// 8 days covers the longest re-fireable window (weekly) with margin.
const WARN_KEY_TTL_MS = 8 * 24 * 3_600_000;

export function pruneWarnKeys(store, now = Date.now()) {
  for (const bucket of [store.fired, store.pending]) {
    if (!bucket) continue;
    for (const [key, at] of Object.entries(bucket)) {
      // Legacy pending entries were `true` (no timestamp) — treat as expired.
      if (!Number.isFinite(at) || now - at > WARN_KEY_TTL_MS) delete bucket[key];
    }
  }
  return store;
}

export function appendCalibration(state, sample) {
  state.calibration ||= {};
  const key = sample.key || calibrationKey(sample.agent, sample.limitType, sample.modelPool);
  const ring = Array.isArray(state.calibration[key]) ? state.calibration[key] : [];
  ring.push({
    at: sample.at,
    limitType: sample.limitType,
    agent: sample.agent,
    windowStart: sample.windowStart ?? null,
    weightedTokens: sample.weightedTokens,
    formulaV: sample.formulaV ?? TOKEN_WEIGHT_FORMULA_V,
    resetAt: sample.resetAt ?? null,
    modelPool: sample.modelPool ?? null,
  });
  while (ring.length > USAGE_CALIBRATION_RING) ring.shift();
  state.calibration[key] = ring;
  return state;
}

// Last n usable samples (by `at`) across the pool-specific and unpooled rings.
function recentCalibrationTokens(calibration, agent, limitType, n, pool) {
  // Prefer pool-specific ring; fall back to unpooled agent:limitType.
  const keys = [];
  if (pool) keys.push(calibrationKey(agent, limitType, pool));
  keys.push(calibrationKey(agent, limitType));
  // Also merge any pool-scoped rings for this agent:limitType when no pool filter.
  if (!pool && calibration) {
    const prefix = `${agent}:${limitType}`;
    for (const k of Object.keys(calibration)) {
      if (k === prefix || k.startsWith(`${prefix}:`)) keys.push(k);
    }
  }
  const seen = new Set();
  const usable = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const ring = calibration?.[key];
    if (!Array.isArray(ring)) continue;
    for (const s of ring) {
      if ((s.formulaV ?? 1) === TOKEN_WEIGHT_FORMULA_V && Number.isFinite(s.weightedTokens)) {
        usable.push(s);
      }
    }
  }
  return usable.sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-n)
    .map(s => s.weightedTokens);
}

export function medianCeiling(calibration, agent, limitType, n = USAGE_CALIBRATION_MEDIAN_N, pool = null) {
  const recent = recentCalibrationTokens(calibration, agent, limitType, n, pool)
    .sort((a, b) => a - b);
  if (recent.length === 0) return null;
  const mid = Math.floor(recent.length / 2);
  return recent.length % 2 === 1
    ? recent[mid]
    : Math.round((recent[mid - 1] + recent[mid]) / 2);
}

// Lowest recently observed stop ceiling — the pessimistic end of the ETA band.
// Needs ≥2 samples; with one, min === median and adds no information.
export function minCeiling(calibration, agent, limitType, n = USAGE_CALIBRATION_MEDIAN_N, pool = null) {
  const recent = recentCalibrationTokens(calibration, agent, limitType, n, pool);
  if (recent.length < 2) return null;
  return Math.min(...recent);
}

export function calibrationStopCount(calibration, agent, limitType, pool = null) {
  if (!calibration) return 0;
  const keys = new Set();
  if (pool) keys.add(calibrationKey(agent, limitType, pool));
  keys.add(calibrationKey(agent, limitType));
  if (!pool) {
    const prefix = `${agent}:${limitType}`;
    for (const k of Object.keys(calibration)) {
      if (k === prefix || k.startsWith(`${prefix}:`)) keys.add(k);
    }
  }
  let n = 0;
  for (const k of keys) {
    const ring = calibration[k];
    if (Array.isArray(ring)) n += ring.length;
  }
  return n;
}

// Clamp spikes (>100) and one-tick stale regressions that jump >15pp upward
// without intermediate samples (Codex can briefly report stale/overshoot %).
export function smoothUsedPercent(current, previous) {
  if (!Number.isFinite(current)) return Number.isFinite(previous) ? previous : null;
  let v = current;
  if (v > 100) v = 100;
  if (v < 0) v = 0;
  if (Number.isFinite(previous) && v > previous + 15 && previous < 95) {
    // Soft-cap upward spike: average with previous for one tick
    v = (v + previous) / 2;
  }
  return v;
}

// Dominant model-pool among samples (for Max per-bucket calibration).
export function dominantModelPool(samples) {
  const counts = new Map();
  for (const s of samples || []) {
    const p = s.modelPool;
    if (!p || p === 'unknown' || p === 'synthetic' || p === 'other') continue;
    counts.set(p, (counts.get(p) || 0) + (s.weighted || 1));
  }
  let best = null, bestN = 0;
  for (const [p, n] of counts) {
    if (n > bestN) { best = p; bestN = n; }
  }
  return best;
}

export function calibrationKey(agent, limitType, pool = null) {
  if (pool && pool !== 'unknown' && pool !== 'synthetic') return `${agent}:${limitType}:${pool}`;
  return `${agent}:${limitType}`;
}

// ---------------------------------------------------------------------------
// Extractors (shared by watcher tick + cold tail-read)
// ---------------------------------------------------------------------------

export function extractClaudeUsage(line) {
  if (!line || !line.trim()) return null;
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  if (!entry || typeof entry !== 'object') return null;
  // Parent transcripts occasionally embed sidechain usage; those turns also
  // live under subagents/agent-*.jsonl. Counting both double-counts the
  // account pool (same rule as sessions.lastUsageTokens).
  if (entry.isSidechain === true) return null;
  // Model lives on message.model in current Claude Code transcripts; top-level
  // entry.model is often null (verified on-disk 2026-07-16).
  const model = entry.message?.model || entry.model || null;
  if (model === '<synthetic>' || modelPool(model) === 'synthetic') return null;
  const u = entry.message?.usage;
  if (!u || typeof u !== 'object') return null;
  const w = weightedTokens(u);
  if (w <= 0) return null;
  const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;
  return {
    agent: 'claude',
    at: ts,
    weighted: w,
    model,
    modelPool: modelPool(model),
    raw: {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheCreate: u.cache_creation_input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
    },
  };
}

// Plan §2.1: exact-tier forecast in %-space — burn = d(pct)/dt, ETA = (100-pct)/burn.
// History is a ring of statusline drops (daemon + CLI reads).
export function recordExactPctSample(store, exactClaude, { now = Date.now(), keepMs = 2 * 3_600_000 } = {}) {
  if (!store || !exactClaude?.fiveHour) return store;
  const pct = exactClaude.fiveHour.used_percentage;
  if (!Number.isFinite(pct)) return store;
  store.exactPct ||= { claude5h: [] };
  const arr = store.exactPct.claude5h;
  const last = arr[arr.length - 1];
  // Dedupe identical % within 30s (statusline can re-fire without movement).
  if (last && last.pct === pct && now - last.at < 30_000) return store;
  arr.push({
    at: now,
    pct: smoothUsedPercent(pct, last?.pct),
    resetsAtMs: normalizeResetsAtMs(exactClaude.fiveHour.resets_at),
  });
  store.exactPct.claude5h = arr
    .filter(s => now - s.at <= keepMs)
    .slice(-120);
  return store;
}

export function pctSpaceEta(history, {
  now = Date.now(),
  minSpanMs = USAGE_BURN_MIN_COVERAGE_MS,
} = {}) {
  const pts = (history || [])
    .filter(h => Number.isFinite(h.at) && Number.isFinite(h.pct) && h.at <= now)
    .sort((a, b) => a.at - b.at);
  if (pts.length < 2) return { warmingUp: true, idle: false, burnPerMin: null, eta: null };
  const first = pts[0];
  const last = pts[pts.length - 1];
  const dtMs = last.at - first.at;
  if (dtMs < minSpanMs) {
    return { warmingUp: true, idle: false, burnPerMin: null, eta: null, activeMin: dtMs / 60_000 };
  }
  const dPct = last.pct - first.pct;
  const dtMin = dtMs / 60_000;
  if (dPct <= 0.05) {
    return { warmingUp: false, idle: true, burnPerMin: 0, eta: null, activeMin: dtMin, unit: 'pct' };
  }
  const pctPerMin = dPct / dtMin;
  const remain = Math.max(0, 100 - last.pct);
  const mins = remain / pctPerMin;
  let eta = { loMs: mins * 60_000 * 0.85, hiMs: mins * 60_000 * 1.15 };
  // Cross-check against resets_at — never pin ETA past window roll.
  if (last.resetsAtMs && now < last.resetsAtMs) {
    const until = last.resetsAtMs - now;
    eta = { loMs: Math.min(eta.loMs, until), hiMs: Math.min(eta.hiMs, until) };
  }
  return {
    warmingUp: false,
    idle: false,
    burnPerMin: pctPerMin,
    activeMin: dtMin,
    unit: 'pct',
    eta,
  };
}

export function extractCodexUsage(line) {
  if (!line || !line.trim()) return null;
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  if (entry?.type !== 'event_msg' || entry.payload?.type !== 'token_count') return null;
  const rl = entry.payload.rate_limits;
  if (!rl || typeof rl !== 'object') return null;

  function win(w) {
    if (!w || typeof w !== 'object') return null;
    const minutes = w.window_minutes;
    return {
      usedPercent: Number.isFinite(w.used_percent) ? w.used_percent : null,
      windowMinutes: Number.isFinite(minutes) ? minutes : null,
      resetsAtMs: normalizeResetsAtMs(w.resets_at),
      label: labelWindow(minutes),
    };
  }

  const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(ts)) return null;
  const primary = win(rl.primary);
  if (!primary) return null;
  return {
    agent: 'codex',
    at: ts,
    primary,
    secondary: win(rl.secondary),
    planType: rl.plan_type || null,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function emptyUsageStore() {
  return { version: 1, samples: [], fired: {}, pending: {}, ewma: {}, exactPct: { claude5h: [] } };
}

export function readUsageStore(path = USAGE_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return emptyUsageStore();
    return {
      version: parsed.version || 1,
      samples: Array.isArray(parsed.samples) ? parsed.samples : [],
      fired: parsed.fired && typeof parsed.fired === 'object' ? parsed.fired : {},
      pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
      ewma: parsed.ewma && typeof parsed.ewma === 'object' ? parsed.ewma : {},
      exactPct: parsed.exactPct && typeof parsed.exactPct === 'object'
        ? { claude5h: Array.isArray(parsed.exactPct.claude5h) ? parsed.exactPct.claude5h : [] }
        : { claude5h: [] },
    };
  } catch {
    return emptyUsageStore();
  }
}

export function writeUsageStore(store, path = USAGE_FILE) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.usage.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, path);
  return store;
}

export function seedUsageFromSamples(samples, { now = Date.now(), keepMs = 6 * 3_600_000 } = {}) {
  const cut = now - keepMs;
  return samples.filter(s => Number.isFinite(s.at) && s.at >= cut);
}

// Build a calibration sample at stop time WITHOUT writing. Caller applies it
// inside the same updateState as the stop upsert (see upsertSession `{ after }`).
// Falls back to a cold mtime-filtered tail-read when the daemon store is empty
// — the moat depends on recording a ceiling even if the watcher never ran.
export function prepareCalibrationSample({
  agent,
  limitType,
  // Raw reset epoch (ms), WITHOUT RESET_MARGIN_MS — margin would shift window start.
  resetAtMs = null,
  now = Date.now(),
  samples = null,
  modelPool: poolHint = null,
} = {}) {
  if (!agent || !limitType || limitType === 'unknown') return null;
  let storeSamples = samples;
  if (!storeSamples) {
    storeSamples = (readUsageStore().samples || [])
      .filter(s => s.agent === agent && s.weighted != null);
  }
  if (storeSamples.length === 0 && agent === 'claude') {
    try {
      storeSamples = collectClaudeSamples({ now, lookbackMs: 6 * 3_600_000 });
    } catch { storeSamples = []; }
  }
  if (storeSamples.length === 0 && agent === 'codex') {
    // Codex calibration is exact-% based; token ceiling not needed for ladder.
    return null;
  }
  // Prefer pool-scoped sum on Max (Opus/Sonnet separate buckets).
  const pool = poolHint || dominantModelPool(storeSamples);
  const poolSamples = pool
    ? storeSamples.filter(s => s.modelPool === pool)
    : storeSamples;
  const useSamples = poolSamples.length > 0 ? poolSamples : storeSamples;

  const windowStart = reconstructWindowStart(useSamples, {
    now,
    resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : null,
    windowMs: 5 * 3_600_000,
  });
  const inWin = useSamples.filter(s => s.at >= windowStart && s.at <= now);
  const total = inWin.reduce((s, x) => s + (x.weighted || 0), 0);
  if (total <= 0) return null;
  return {
    at: now,
    agent,
    limitType,
    windowStart,
    weightedTokens: total,
    formulaV: TOKEN_WEIGHT_FORMULA_V,
    resetAt: resetAtMs,
    modelPool: pool,
    key: calibrationKey(agent, limitType, pool),
  };
}

// Convenience: prepare + write in its own lock (monitor/watcher when not
// pairing with upsert). Prefer prepare + upsertSession({ after }) when possible.
export function snapshotCalibrationAtStop(opts = {}) {
  const sample = prepareCalibrationSample(opts);
  if (!sample) return null;
  updateState(state => {
    appendCalibration(state, sample);
    return state;
  });
  return sample;
}

// After-hook for upsertSession — apply pre-built calibration sample under the
// same state lock as the stop record.
export function applyCalibrationToState(state, sample) {
  if (!sample || !state) return state;
  return appendCalibration(state, sample);
}

// Best reset-window anchor from tracked stops / statusline (never blind now+5h).
export function resolveClaudeResetAnchor({
  exactClaude = null,
  sessions = null,
  now = Date.now(),
} = {}) {
  if (exactClaude?.fiveHour?.resets_at != null) {
    const ms = normalizeResetsAtMs(exactClaude.fiveHour.resets_at);
    if (ms != null && ms > now - 60_000) {
      return { resetAtMs: ms, source: 'statusline', windowMs: 5 * 3_600_000 };
    }
  }
  // Prefer a live stopped/resuming Claude 5h record with absolute/transcript reset.
  const list = sessions
    ? Object.values(sessions)
    : Object.values(readState().sessions || {});
  let best = null;
  for (const s of list) {
    if (s.agent && s.agent !== 'claude') continue;
    if (!['stopped', 'resuming'].includes(s.status)) continue;
    if (s.limitType && s.limitType !== '5h' && s.limitType !== 'unknown') continue;
    if (!Number.isFinite(s.resetAt)) continue;
    // resetAt in ledger includes RESET_MARGIN_MS — peel ~60s for window math.
    const raw = s.resetAt - 60_000;
    if (raw <= now - 60_000) continue;
    if (!best || (s.detectedAt || 0) > (best.detectedAt || 0)) {
      best = { ...s, rawReset: raw };
    }
  }
  if (best) {
    return {
      resetAtMs: best.rawReset,
      source: best.resetSource || 'banner',
      windowMs: 5 * 3_600_000,
    };
  }
  return { resetAtMs: null, source: null, windowMs: 5 * 3_600_000 };
}

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

function sumWeightedInWindow(samples, windowStart, now) {
  return samples
    .filter(s => s.at >= windowStart && s.at <= now && Number.isFinite(s.weighted))
    .reduce((s, x) => s + (x.weighted || 0), 0);
}

function ewmaBurn(prev, current, alpha = 0.3) {
  if (!Number.isFinite(current)) return prev ?? null;
  if (!Number.isFinite(prev)) return current;
  return alpha * current + (1 - alpha) * prev;
}

export function buildUsageReport({
  now = Date.now(),
  claudeSamples = [],
  codexSamples = [],
  calibration = {},
  exactClaude = null, // { fiveHour: {used_percentage, resets_at}, sevenDay: {...} }
  ewma = {},
  sessions = null,
  exactPctHistory = null, // [{at,pct,resetsAtMs}] for Claude %-space ETA
} = {}) {
  const agents = [];
  const ewmaOut = { ...ewma };

  // --- Claude ---
  {
    const anchor = resolveClaudeResetAnchor({ exactClaude, sessions, now });
    // Max: separate Opus/Sonnet buckets. If multiple pools have recent weight,
    // report each; otherwise a single combined/unknown line.
    const poolsPresent = new Map(); // pool -> samples
    for (const s of claudeSamples) {
      const p = s.modelPool && s.modelPool !== 'synthetic' ? s.modelPool : 'unknown';
      if (!poolsPresent.has(p)) poolsPresent.set(p, []);
      poolsPresent.get(p).push(s);
    }
    const significant = [...poolsPresent.entries()]
      .filter(([p, ss]) => p === 'opus' || p === 'sonnet')
      .filter(([, ss]) => ss.reduce((a, s) => a + (s.weighted || 0), 0) > 0);
    const multiBucket = significant.length >= 2;

    const windows = [];
    const buildClaudeWindow = (label, samples, pool) => {
      const windowStart = reconstructWindowStart(samples, {
        now,
        resetAtMs: anchor.resetAtMs,
        windowMs: anchor.windowMs,
      });
      const used = sumWeightedInWindow(samples, windowStart, now);
      const ceiling = medianCeiling(calibration, 'claude', '5h', USAGE_CALIBRATION_MEDIAN_N, pool);
      const stopCount = calibrationStopCount(calibration, 'claude', '5h', pool);
      // Exact % is account-level (statusline) — only attach to the combined/primary line.
      const exactPct = (!pool || !multiBucket) && exactClaude?.fiveHour?.used_percentage;
      const ladder = ladderUsage({
        exactPct: Number.isFinite(exactPct) ? exactPct : null,
        used,
        ceiling,
        stopCount,
      });

      // Prefer %-space burn/ETA when we have exact statusline history (plan §2.1).
      // Fall back to token-space burn for calibrated/estimated tiers.
      let burn;
      let etaFinal = null;
      if (Number.isFinite(exactPct) && Array.isArray(exactPctHistory) && exactPctHistory.length >= 2) {
        const pctEta = pctSpaceEta(exactPctHistory, { now });
        if (pctEta.warmingUp) {
          burn = { idle: false, warmingUp: true, burnPerMin: null, activeMin: pctEta.activeMin || 0, unit: 'pct' };
        } else if (pctEta.idle) {
          burn = { idle: true, warmingUp: false, burnPerMin: 0, activeMin: pctEta.activeMin || 0, unit: 'pct' };
        } else {
          burn = {
            idle: false,
            warmingUp: false,
            burnPerMin: pctEta.burnPerMin,
            activeMin: pctEta.activeMin,
            unit: 'pct',
          };
          etaFinal = pctEta.eta;
        }
      } else {
        burn = burnRate(samples, { now });
        const ewmaKey = pool ? `claude:5h:${pool}` : 'claude:5h';
        const burnEwma = ewmaBurn(ewma[ewmaKey], burn.burnPerMin);
        if (Number.isFinite(burn.burnPerMin) && burn.burnPerMin > 0) {
          ewmaOut[ewmaKey] = burnEwma;
        }
        if (!burn.idle && !burn.warmingUp && ladder.ceiling) {
          etaFinal = etaBand({
            used: ladder.used ?? used,
            ceiling: ladder.ceiling,
            burnCurrent: burn.burnPerMin,
            burnEwma,
            // Pessimistic = lowest recently observed stop ceiling; the ×0.9
            // proxy only backstops the single-calibration-point case.
            ceilingPess: minCeiling(calibration, 'claude', '5h', USAGE_CALIBRATION_MEDIAN_N, pool)
              ?? (ceiling != null ? ceiling * 0.9 : null),
          });
        }
      }
      // Cross-check ETA against resets_at
      if (etaFinal && anchor.resetAtMs && now < anchor.resetAtMs) {
        const until = anchor.resetAtMs - now;
        etaFinal = {
          loMs: Math.min(etaFinal.loMs, until),
          hiMs: Math.min(etaFinal.hiMs, until),
        };
      }
      return {
        label,
        pool: pool || null,
        ladder,
        burn,
        eta: etaFinal,
        resetsAtMs: anchor.resetAtMs,
        resetSource: anchor.source,
        infoOnly: false,
      };
    };

    if (multiBucket) {
      for (const [pool, ss] of significant) {
        windows.push(buildClaudeWindow(`5h/${pool}`, ss, pool));
      }
    } else {
      windows.push(buildClaudeWindow('5h', claudeSamples, dominantModelPool(claudeSamples)));
    }

    // Weekly: info-only (no ETA in MVP)
    const weeklyExact = exactClaude?.sevenDay?.used_percentage;
    if (Number.isFinite(weeklyExact) || calibrationStopCount(calibration, 'claude', 'weekly') > 0) {
      const wCeil = medianCeiling(calibration, 'claude', 'weekly');
      const wStops = calibrationStopCount(calibration, 'claude', 'weekly');
      windows.push({
        label: 'weekly',
        pool: null,
        ladder: ladderUsage({
          exactPct: Number.isFinite(weeklyExact) ? weeklyExact : null,
          used: null,
          ceiling: wCeil,
          stopCount: wStops,
        }),
        burn: null,
        eta: null,
        resetsAtMs: exactClaude?.sevenDay
          ? normalizeResetsAtMs(exactClaude.sevenDay.resets_at)
          : null,
        resetSource: exactClaude?.sevenDay ? 'statusline' : null,
        infoOnly: true,
      });
    }

    agents.push({ agent: 'claude', windows, lowerBound: true });
  }

  // --- Codex ---
  {
    const latest = [...codexSamples].sort((a, b) => a.at - b.at).at(-1);
    const prev = codexSamples.length >= 2
      ? [...codexSamples].sort((a, b) => a.at - b.at).at(-2)
      : null;
    if (latest?.primary) {
      const windows = [];
      for (const key of ['primary', 'secondary']) {
        const w = latest[key];
        if (!w) continue;
        const prevW = prev?.[key];
        const pct = smoothUsedPercent(w.usedPercent, prevW?.usedPercent);
        const label = w.label || labelWindow(w.windowMinutes);
        // %-space burn for ETA on the primary/short window only
        let burn = { idle: true, burnPerMin: 0, activeMin: 0, warmingUp: false };
        let eta = null;
        if (key === 'primary' && prevW && Number.isFinite(pct) && Number.isFinite(prevW.usedPercent)) {
          const dtMin = (latest.at - prev.at) / 60_000;
          if (dtMin > 0) {
            const dPct = Math.max(0, pct - prevW.usedPercent);
            // Treat very small dt with no movement as idle
            if (dPct <= 0.01) {
              burn = { idle: true, burnPerMin: 0, activeMin: dtMin, warmingUp: false };
            } else {
              const pctPerMin = dPct / dtMin;
              burn = {
                idle: false,
                burnPerMin: pctPerMin, // percent points per min
                activeMin: dtMin,
                warmingUp: dtMin * 60_000 < USAGE_BURN_MIN_COVERAGE_MS,
                unit: 'pct',
              };
              if (!burn.warmingUp && pct < 100) {
                const remain = 100 - pct;
                const mins = remain / pctPerMin;
                eta = { loMs: mins * 60_000 * 0.85, hiMs: mins * 60_000 * 1.15 };
              }
            }
          }
        }
        // Cross-check: don't pin ETA past resets_at
        if (eta && w.resetsAtMs && now < w.resetsAtMs) {
          const untilReset = w.resetsAtMs - now;
          eta = { loMs: Math.min(eta.loMs, untilReset), hiMs: Math.min(eta.hiMs, untilReset) };
        }
        windows.push({
          label,
          ladder: ladderUsage({ exactPct: pct }),
          burn: key === 'primary' ? burn : null,
          eta: key === 'primary' ? eta : null,
          resetsAtMs: w.resetsAtMs,
          resetSource: 'exact',
          infoOnly: label === 'weekly' || label === '30d' || (w.windowMinutes || 0) >= 7 * 1440,
        });
      }
      agents.push({ agent: 'codex', windows, lowerBound: false });
    } else {
      agents.push({ agent: 'codex', windows: [], lowerBound: false });
    }
  }

  return { now, agents, ewma: ewmaOut };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function asciiBar(pct, width = 20) {
  const p = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  const filled = Math.round((p / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function fmtTok(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1000) return `~${Math.round(n / 1000)}k`;
  return `~${Math.round(n)}`;
}

function fmtReset(ms) {
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: ms - Date.now() > 86_400_000 ? 'short' : undefined,
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

export function formatUsageText(report) {
  const warn = (report.warnAt || DEFAULT_USAGE_WARN_AT).join(',');
  const daemon = report.daemonRunning ? 'running' : 'not running';
  const lines = [
    `unsnooze usage — account burn & time-to-limit  (daemon: ${daemon} · warnings at ${warn}%)`,
    '',
  ];

  for (const a of report.agents || []) {
    if (!a.windows || a.windows.length === 0) {
      lines.push(`  ${a.agent.padEnd(7)} (no recent usage data)`);
      lines.push('');
      continue;
    }
    let first = true;
    for (const w of a.windows) {
      const pctStr = w.ladder?.pct != null
        ? `${w.ladder.tier === 'exact' ? '' : '~'}${Math.round(w.ladder.pct)}%${w.ladder.tier === 'exact' ? ' used' : ''}`
        : (w.ladder?.used != null ? `${fmtTok(w.ladder.used)} weighted tok` : '—');
      const bar = asciiBar(w.ladder?.pct ?? 0);
      const prov = fmtUsageProvenance(w.ladder);
      const head = first ? a.agent.padEnd(7) : ' '.repeat(7);
      lines.push(`  ${head} ${w.label.padEnd(7)} [${bar}]  ${pctStr}  ${prov}`);
      first = false;

      if (w.burn && !w.infoOnly) {
        if (w.burn.idle) {
          lines.push(`${' '.repeat(10)}burn    idle — no active burn`);
        } else if (w.burn.warmingUp) {
          lines.push(`${' '.repeat(10)}burn    warming up (<10 active min)`);
        } else if (w.burn.unit === 'pct') {
          lines.push(`${' '.repeat(10)}burn    ~${w.burn.burnPerMin.toFixed(2)} %/min over last ${Math.round(w.burn.activeMin)} active min`);
        } else {
          lines.push(`${' '.repeat(10)}burn    ${fmtTok(w.burn.burnPerMin)} weighted tok/min over last ${Math.round(w.burn.activeMin)} active min`);
        }
      }

      if (w.eta && !w.infoOnly) {
        const lo = fmtDuration(w.eta.loMs);
        const hi = fmtDuration(w.eta.hiMs);
        const wall = lo && hi && lo !== hi ? `~${lo}–${hi}` : `~${lo || hi}`;
        const reset = w.resetsAtMs
          ? ` · window resets ${fmtReset(w.resetsAtMs)}${w.resetSource ? ` (${w.resetSource})` : ''}`
          : '';
        lines.push(`${' '.repeat(10)}wall    ${wall} at this pace${reset}`);
      } else if (w.resetsAtMs) {
        // Always surface known resets (Codex exact secondary, weekly info, idle primary).
        const src = w.resetSource ? ` (${w.resetSource})` : '';
        lines.push(`${' '.repeat(10)}        resets ${fmtReset(w.resetsAtMs)}${src}`);
      }
    }
    lines.push('');
  }

  lines.push('  Estimates are a lower bound: Claude quotas are account-pooled with claude.ai/Desktop.');
  lines.push('  Exact Claude percentages available via: unsnooze usage --install-statusline');
  return lines.join('\n');
}

export function usageReportToJson(report) {
  return {
    version: 1,
    now: report.now,
    daemonRunning: !!report.daemonRunning,
    warnAt: report.warnAt || DEFAULT_USAGE_WARN_AT,
    agents: (report.agents || []).map(a => ({
      agent: a.agent,
      lowerBound: !!a.lowerBound,
      windows: (a.windows || []).map(w => ({
        label: w.label,
        tier: w.ladder?.tier,
        pct: w.ladder?.pct,
        used: w.ladder?.used ?? null,
        ceiling: w.ladder?.ceiling ?? null,
        stopCount: w.ladder?.stopCount ?? 0,
        provenance: fmtUsageProvenance(w.ladder),
        burnPerMin: w.burn?.burnPerMin ?? null,
        activeMin: w.burn?.activeMin ?? null,
        idle: w.burn?.idle ?? null,
        warmingUp: w.burn?.warmingUp ?? null,
        etaLoMs: w.eta?.loMs ?? null,
        etaHiMs: w.eta?.hiMs ?? null,
        resetsAtMs: w.resetsAtMs ?? null,
        infoOnly: !!w.infoOnly,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Cold path: scan recent transcript/rollout files
// ---------------------------------------------------------------------------

const MAX_WALK_DEPTH = 8;
const TAIL_READ_MAX = 4 * 1024 * 1024;

// Walk with optional mtime cut so cold CLI never opens cold files.
// `onCandidate(path)` is called only for files that pass name+mtime filters
// (perf guard / tests can spy on this instead of raw fs).
function walkRecentFiles(dir, depth, { cutMs, match, onCandidate }) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_WALK_DEPTH) walkRecentFiles(p, depth + 1, { cutMs, match, onCandidate });
      continue;
    }
    if (!e.isFile()) continue;
    if (match && !match(p)) continue;
    let mtime;
    try { mtime = statSync(p).mtimeMs; } catch { continue; }
    if (cutMs != null && mtime < cutMs) continue;
    onCandidate(p, mtime);
  }
}

function tailLines(path, maxBytes = TAIL_READ_MAX) {
  let fd;
  try {
    const { size } = statSync(path);
    if (size <= 0) return [];
    fd = openSync(path, 'r');
    const len = Math.min(maxBytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf-8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1);
    return text.split('\n').filter(l => l.trim());
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function collectClaudeSamples({
  roots = [join(CLAUDE_DIR, 'projects')],
  now = Date.now(),
  lookbackMs = 6 * 3_600_000,
  includeSubagents = true,
  onFile = null, // spy: (path) => void — only files that will be tail-read
} = {}) {
  const cut = now - lookbackMs;
  const samples = [];
  const match = (path) => {
    if (!path.endsWith('.jsonl')) return false;
    const parts = path.split(sep);
    const isSub = parts.includes('subagents');
    if (isSub && !includeSubagents) return false;
    if (!isSub && !/^[0-9a-f-]{36}\.jsonl$/i.test(basename(path))) return false;
    if (isSub && !/agent-.*\.jsonl$/i.test(basename(path))) return false;
    return true;
  };
  for (const root of roots) {
    walkRecentFiles(root, 0, {
      cutMs: cut,
      match,
      onCandidate(path) {
        onFile?.(path);
        for (const line of tailLines(path)) {
          const s = extractClaudeUsage(line);
          if (s && s.at >= cut) samples.push(s);
        }
      },
    });
  }
  return samples;
}

export function collectCodexSamples({
  roots = [join(CODEX_DIR, 'sessions')],
  now = Date.now(),
  lookbackMs = 6 * 3_600_000,
  onFile = null,
} = {}) {
  const cut = now - lookbackMs;
  const samples = [];
  const match = (path) => ROLLOUT_RE.test(basename(path));
  for (const root of roots) {
    walkRecentFiles(root, 0, {
      cutMs: cut,
      match,
      onCandidate(path) {
        onFile?.(path);
        for (const line of tailLines(path)) {
          const s = extractCodexUsage(line);
          if (s && s.at >= cut) samples.push(s);
        }
      },
    });
  }
  return samples;
}

export function readExactClaudeFromStatusline({
  dir = USAGE_STATUSLINE_DIR,
  maxAgeMs = 15 * 60_000,
  now = Date.now(),
} = {}) {
  let entries;
  try { entries = readdirSync(dir); } catch { return null; }
  let best = null;
  for (const name of entries) {
    if (!name.startsWith('usage-') || !name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (now - st.mtimeMs > maxAgeMs) continue;
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      const rl = data?.rate_limits || data;
      if (!rl || typeof rl !== 'object') continue;
      if (!best || st.mtimeMs > best.mtime) {
        best = {
          mtime: st.mtimeMs,
          fiveHour: rl.five_hour || rl.fiveHour || null,
          sevenDay: rl.seven_day || rl.sevenDay || null,
        };
      }
    } catch { /* skip bad drop files */ }
  }
  return best ? { fiveHour: best.fiveHour, sevenDay: best.sevenDay } : null;
}

// ---------------------------------------------------------------------------
// Warn engine (daemon)
// ---------------------------------------------------------------------------

export function evaluateUsageWarnings(report, store, {
  warnAt = DEFAULT_USAGE_WARN_AT,
  etaWarnMin = USAGE_ETA_WARN_MIN,
} = {}) {
  const fires = [];
  for (const a of report.agents || []) {
    for (const w of a.windows || []) {
      if (w.infoOnly) continue;
      const pct = w.ladder?.pct;
      const resetsAt = w.resetsAtMs ?? 'none';
      if (Number.isFinite(pct)) {
        for (const thr of warnAt) {
          const key = warnKeysFor({
            agent: a.agent, limitType: w.label, resetsAt, threshold: String(thr),
          });
          const crossed = pct >= thr;
          if (shouldFireWarn(store, key, crossed)) {
            fires.push({
              key, agent: a.agent, label: w.label, kind: 'pct', threshold: thr,
              pct, eta: w.eta, ladder: w.ladder, tier: thr >= Math.max(...warnAt) ? 'high' : 'mid',
            });
            recordWarnFired(store, key);
          }
        }
      }
      // Time-to-wall tiers (use hiMs = optimistic end of band still imminent)
      if (w.eta && Number.isFinite(w.eta.loMs)) {
        for (const mins of etaWarnMin) {
          const thr = `eta${mins}`;
          const key = warnKeysFor({
            agent: a.agent, limitType: w.label, resetsAt, threshold: thr,
          });
          const crossed = w.eta.loMs <= mins * 60_000;
          if (shouldFireWarn(store, key, crossed)) {
            fires.push({
              key, agent: a.agent, label: w.label, kind: 'eta', threshold: mins,
              pct, eta: w.eta, ladder: w.ladder, tier: mins <= 10 ? 'high' : 'mid',
            });
            recordWarnFired(store, key);
          }
        }
      }
    }
  }
  return fires;
}

export function formatWarnMessage(fire, { ctxTokens = null } = {}) {
  const pct = fire.pct != null ? `~${Math.round(fire.pct)}%` : 'usage';
  const prov = fmtUsageProvenance(fire.ladder);
  const eta = fire.eta ? ` — ~${fmtDuration(fire.eta.loMs)} at this pace` : '';
  const ctx = ctxTokens != null ? ` (ctx ${fmtTok(ctxTokens)} tok)` : '';
  return `${fire.agent} ${fire.label} window ${pct} ${prov}${eta}. /compact now${ctx} makes the eventual wake cheap.`;
}

// Accumulate samples from a watcher tick (daemon path — zero extra IO when
// extractors run over the same appended lines).
export function accumulateUsageSamples(store, newSamples, { now = Date.now(), keepMs = 6 * 3_600_000 } = {}) {
  store.samples = seedUsageFromSamples(
    [...(store.samples || []), ...newSamples],
    { now, keepMs },
  );
  return store;
}

// ---------------------------------------------------------------------------
// Statusline shim (opt-in Claude exact tier)
// ---------------------------------------------------------------------------

const SHIM_MARKER = 'unsnooze-statusline-shim';

// Durable shim script written to ~/.claude/unsnooze/statusline-shim.js
export function writeStatuslineShimScript(dir = USAGE_STATUSLINE_DIR) {
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, 'statusline-shim.js');
  const body = `#!/usr/bin/env node
// ${SHIM_MARKER} — chain-safe Claude Code statusLine helper for unsnooze usage.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { /* empty */ }
let data = {};
try { data = JSON.parse(raw || '{}'); } catch { /* ignore */ }

const dir = path.join(os.homedir(), '.claude', 'unsnooze');
try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
const sid = data.session_id || data.sessionId || 'unknown';
const drop = path.join(dir, 'usage-' + sid + '.json');
try {
  fs.writeFileSync(drop, JSON.stringify({
    rate_limits: data.rate_limits || null,
    at: Date.now(),
    sessionId: sid,
  }));
} catch { /* ignore */ }

const orig = process.env.UNSNOOZE_STATUSLINE_ORIG || '';
if (orig) {
  const r = spawnSync(orig, {
    input: raw, encoding: 'utf8', shell: true, env: process.env, maxBuffer: 2 * 1024 * 1024,
  });
  process.stdout.write(r.stdout || '');
  process.exit(r.status ?? 0);
}
const rl = data.rate_limits || {};
const fh = rl.five_hour || rl.fiveHour;
const pct = fh && fh.used_percentage != null ? Math.round(fh.used_percentage) + '%' : '?';
process.stdout.write('unsnooze ' + pct);
`;
  writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

function backupOnce(filePath) {
  const bak = `${filePath}.unsnooze.bak`;
  if (existsSync(filePath) && !existsSync(bak)) {
    try {
      writeFileSync(bak, readFileSync(filePath));
    } catch { /* best-effort */ }
  }
}

export function installStatuslineShim({
  settingsPath = join(CLAUDE_DIR, 'settings.json'),
  shimDir = USAGE_STATUSLINE_DIR,
} = {}) {
  const scriptPath = writeStatuslineShimScript(shimDir);
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    settings = {};
  }
  if (!settings || typeof settings !== 'object') settings = {};

  const existing = settings.statusLine;
  let originalCmd = '';
  if (existing && typeof existing === 'object' && existing.command) {
    originalCmd = String(existing.command);
  } else if (typeof existing === 'string') {
    originalCmd = existing;
  }
  // Already our shim?
  if (originalCmd.includes(SHIM_MARKER) || originalCmd.includes('statusline-shim.js')) {
    return { ok: true, already: true, scriptPath };
  }

  backupOnce(settingsPath);
  // Persist original so uninstall/chain can restore
  const metaPath = join(shimDir, 'statusline-original.json');
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(metaPath, JSON.stringify({ command: originalCmd || null, at: Date.now() }, null, 2));

  const command = originalCmd
    ? `UNSNOOZE_STATUSLINE_ORIG=${JSON.stringify(originalCmd)} node ${JSON.stringify(scriptPath)}`
    : `node ${JSON.stringify(scriptPath)}`;

  settings.statusLine = {
    type: 'command',
    command,
    // padding kept if Claude supports it — harmless
    ...(existing && typeof existing === 'object' && existing.padding != null
      ? { padding: existing.padding }
      : {}),
  };

  mkdirSync(dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, settingsPath);
  return { ok: true, already: false, scriptPath, originalCmd: originalCmd || null };
}

export function uninstallStatuslineShim({
  settingsPath = join(CLAUDE_DIR, 'settings.json'),
  shimDir = USAGE_STATUSLINE_DIR,
} = {}) {
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    return { ok: true, removed: false };
  }
  const cmd = settings?.statusLine?.command || settings?.statusLine || '';
  if (typeof cmd === 'string' && !(cmd.includes(SHIM_MARKER) || cmd.includes('statusline-shim.js'))) {
    return { ok: true, removed: false };
  }
  let original = null;
  try {
    original = JSON.parse(readFileSync(join(shimDir, 'statusline-original.json'), 'utf-8'));
  } catch { /* none */ }

  if (original?.command) {
    settings.statusLine = { type: 'command', command: original.command };
  } else {
    delete settings.statusLine;
  }
  const tmp = `${settingsPath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, settingsPath);
  return { ok: true, removed: true };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function daemonPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function cmdUsage(args = []) {
  if (args.includes('--install-statusline')) {
    try {
      const r = installStatuslineShim();
      if (r.already) {
        console.log('unsnooze: statusline shim already installed.');
      } else {
        console.log(`unsnooze: statusline shim installed → ${r.scriptPath}`);
        if (r.originalCmd) console.log('  chained previous statusLine command.');
        console.log('  Exact Claude % will appear in `unsnooze usage` after the next turn.');
      }
      return 0;
    } catch (err) {
      console.error(`unsnooze: failed to install statusline shim: ${err.message}`);
      return 1;
    }
  }
  if (args.includes('--uninstall-statusline')) {
    try {
      const r = uninstallStatuslineShim();
      console.log(r.removed
        ? 'unsnooze: statusline shim removed (original restored if known).'
        : 'unsnooze: no statusline shim found.');
      return 0;
    } catch (err) {
      console.error(`unsnooze: failed to uninstall statusline shim: ${err.message}`);
      return 1;
    }
  }

  const asJson = args.includes('--json');
  // Interactive TTY (human path) → live dashboard Usage tab
  if (!asJson && shouldUseDashboard()) return runDashboard({ tab: 'usage' });
  try {
    const now = Date.now();
    const state = readState();
    const store = readUsageStore();
    // Prefer daemon-accumulated samples when fresh; always cold-scan to fill gaps.
    const claudeCold = collectClaudeSamples({ now });
    const codexCold = collectCodexSamples({ now });
    const fromStoreClaude = (store.samples || []).filter(s => s.agent === 'claude' && s.weighted != null);
    const fromStoreCodex = (store.samples || []).filter(s => s.agent === 'codex' && s.primary);
    const claudeSamples = mergeSamples(fromStoreClaude, claudeCold);
    const codexSamples = mergeSamples(fromStoreCodex, codexCold);

    const exactClaude = readExactClaudeFromStatusline({ now });
    // usage.json is daemon single-writer (plan §6). CLI only reads exactPct
    // history the daemon recorded; without daemon, exact % still shows, ETA
    // warms after the daemon has seen ≥2 statusline drops.
    const report = buildUsageReport({
      now,
      claudeSamples,
      codexSamples,
      calibration: state.calibration || {},
      exactClaude,
      ewma: store.ewma || {},
      sessions: state.sessions,
      exactPctHistory: store.exactPct?.claude5h || [],
    });
    report.daemonRunning = daemonPidAlive(state.resumerPid);
    report.warnAt = parseUsageWarnAt(getConfig('usageWarnAt'));

    if (asJson) {
      console.log(JSON.stringify(usageReportToJson(report), null, 2));
    } else if (shouldUseTui({ json: asJson })) {
      console.log(formatUsageTui(report, {
        color: true,
        asciiBar: (pct, width, opts) => tuiBar(pct, width, opts),
        fmtDuration,
        fmtUsageProvenance,
      }));
    } else {
      console.log(formatUsageText(report));
    }

    return usageExitCode(report);
  } catch (err) {
    console.error(`unsnooze usage: ${err.message}`);
    return 1;
  }
}

// Exit codes: 0 normal · 2 past highest warn threshold · 1 reserved for errors (caller).
export function usageExitCode(report) {
  const warnAt = report.warnAt || DEFAULT_USAGE_WARN_AT;
  if (!warnAt.length) return 0;
  const high = Math.max(...warnAt);
  const over = (report.agents || []).some(a =>
    (a.windows || []).some(w => !w.infoOnly && w.ladder?.pct != null && w.ladder.pct >= high));
  return over ? 2 : 0;
}

function mergeSamples(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const s of list) {
      // Dedupe by agent+at+kind
      const key = `${s.agent}:${s.at}:${s.weighted ?? s.primary?.usedPercent ?? 0}`;
      if (!map.has(key)) map.set(key, s);
    }
  }
  return [...map.values()].sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------
// Daemon tick helper
// ---------------------------------------------------------------------------

export async function tickUsageWarnings({
  notifyFn = null,
  now = Date.now(),
} = {}) {
  if (getConfig('usageWarn') === 'off') return 0;
  if (!getConfig('notifications')) return 0;

  const state = readState();
  const store = readUsageStore();
  const claudeSamples = (store.samples || []).filter(s => s.agent === 'claude' && s.weighted != null);
  const codexSamples = (store.samples || []).filter(s => s.agent === 'codex' && s.primary);
  // If store is empty, don't cold-scan on every poll — watcher seeds it.
  if (claudeSamples.length === 0 && codexSamples.length === 0) return 0;

  const exactClaude = readExactClaudeFromStatusline({ now });
  if (exactClaude) recordExactPctSample(store, exactClaude, { now });
  const report = buildUsageReport({
    now,
    claudeSamples,
    codexSamples,
    calibration: state.calibration || {},
    exactClaude,
    ewma: store.ewma || {},
    sessions: state.sessions,
    exactPctHistory: store.exactPct?.claude5h || [],
  });
  // Persist EWMA so ETA bands stay stable across ticks.
  if (report.ewma) store.ewma = report.ewma;

  const warnAt = parseUsageWarnAt(getConfig('usageWarnAt'));
  pruneWarnKeys(store, now);
  const fires = evaluateUsageWarnings(report, store, { warnAt });
  if (fires.length === 0) {
    writeUsageStore(store);
    return 0;
  }

  // Reuse contextGuard estimator so warn wording agrees with `unsnooze status`.
  let ctxTokens = null;
  try {
    const { getAgent } = await import('./agents/index.js');
    const stopped = Object.values(state.sessions || {})
      .filter(s => s.status === 'stopped' && s.agent === 'claude')
      .sort((a, b) => (b.detectedAt || 0) - (a.detectedAt || 0))[0];
    if (stopped) {
      const agent = getAgent(stopped.agent || 'claude');
      ctxTokens = agent.contextTokens?.(stopped) ?? null;
    }
  } catch { /* estimate unavailable — omit */ }

  const { notify } = notifyFn ? { notify: notifyFn } : await import('./notify.js');
  for (const fire of fires) {
    const body = formatWarnMessage(fire, { ctxTokens });
    const title = fire.tier === 'high' ? 'usage wall soon ⚠️' : 'usage warning';
    try {
      notify(title, body, { priority: fire.tier === 'high' ? 4 : 3 });
    } catch { /* never break the daemon */ }
  }
  writeUsageStore(store);
  return fires.length;
}
