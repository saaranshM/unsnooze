// Pure math + extractors for 1.13 usage forecast (burn rate, ETA, calibration ladder).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, utimesSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-usage-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const {
  TOKEN_WEIGHT_FORMULA_V,
  weightedTokens,
  modelPool,
  labelWindow,
  normalizeResetsAtMs,
  reconstructWindowStart,
  activeMinutes,
  burnRate,
  etaBand,
  ladderUsage,
  fmtUsageProvenance,
  parseUsageWarnAt,
  DEFAULT_USAGE_WARN_AT,
  warnKeysFor,
  shouldFireWarn,
  recordWarnFired,
  pruneWarnKeys,
  medianCeiling,
  minCeiling,
  usageReportToJson,
  appendCalibration,
  smoothUsedPercent,
  extractClaudeUsage,
  extractCodexUsage,
  asciiBar,
  fmtDuration,
  formatUsageText,
  buildUsageReport,
  readUsageStore,
  writeUsageStore,
  seedUsageFromSamples,
  installStatuslineShim,
  uninstallStatuslineShim,
  formatWarnMessage,
  evaluateUsageWarnings,
  prepareCalibrationSample,
  applyCalibrationToState,
  calibrationKey,
  recordExactPctSample,
  pctSpaceEta,
  usageExitCode,
  collectClaudeSamples,
} = await import('../src/usage.js');

const { readState, updateState } = await import('../src/state.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

// --- weighting ---

test('weightedTokens: cache_read counts ~0.1×; formula version is stable', () => {
  assert.equal(TOKEN_WEIGHT_FORMULA_V, 1);
  // 1000 input + 500 out + 200 cache_create + 10_000 cache_read
  // = 1000 + 500 + 200 + 1000 = 2700
  assert.equal(weightedTokens({
    input_tokens: 1000,
    output_tokens: 500,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 10_000,
  }), 2700);
  assert.equal(weightedTokens({ input_tokens: 0, output_tokens: 0 }), 0);
  assert.equal(weightedTokens(null), 0);
});

test('modelPool groups Max buckets', () => {
  assert.equal(modelPool('claude-opus-4-20250514'), 'opus');
  assert.equal(modelPool('claude-sonnet-4-20250514'), 'sonnet');
  assert.equal(modelPool('claude-haiku-3-5'), 'haiku');
  assert.equal(modelPool('<synthetic>'), 'synthetic');
  assert.equal(modelPool(null), 'unknown');
});

// --- window labels & epochs ---

test('labelWindow derives labels from minutes (never assumes 5h/weekly)', () => {
  assert.equal(labelWindow(300), '5h');
  assert.equal(labelWindow(10080), 'weekly');
  assert.equal(labelWindow(43200), '30d');
  assert.equal(labelWindow(60), '1h');
  assert.equal(labelWindow(null), 'unknown');
});

test('normalizeResetsAtMs: seconds vs ms at one boundary', () => {
  assert.equal(normalizeResetsAtMs(1_778_672_230), 1_778_672_230_000); // seconds
  assert.equal(normalizeResetsAtMs(1_778_672_230_000), 1_778_672_230_000); // already ms
  assert.equal(normalizeResetsAtMs(null), null);
  assert.equal(normalizeResetsAtMs('nope'), null);
});

// --- window reconstruction ---

test('reconstructWindowStart: walks back until ≥5h idle gap', () => {
  const now = Date.parse('2026-07-16T18:00:00Z');
  const samples = [
    { at: now - 30 * 60_000, weighted: 100 },
    { at: now - 90 * 60_000, weighted: 100 },
    // 90min + 5h + 1min earlier than the mid sample → gap ≥5h breaks the window
    { at: now - 90 * 60_000 - 5 * 3_600_000 - 60_000, weighted: 100 },
  ];
  const start = reconstructWindowStart(samples, { now, maxIdleMs: 5 * 3_600_000 });
  assert.equal(start, now - 90 * 60_000);
});

test('reconstructWindowStart prefers observed resets_at anchor', () => {
  const now = Date.parse('2026-07-16T18:00:00Z');
  const resetAt = now + 60 * 60_000; // window ends in 1h → started ~4h ago for 5h window
  const samples = [
    { at: now - 30 * 60_000, weighted: 50 },
    { at: now - 4.5 * 3_600_000, weighted: 50 },
  ];
  const start = reconstructWindowStart(samples, {
    now,
    maxIdleMs: 5 * 3_600_000,
    resetAtMs: resetAt,
    windowMs: 5 * 3_600_000,
  });
  assert.equal(start, resetAt - 5 * 3_600_000);
});

// --- active minutes & burn ---

test('activeMinutes excludes idle gaps >5 min', () => {
  const now = Date.parse('2026-07-16T18:00:00Z');
  // Two active clusters (2-min spacing) with a 20-min idle gap between them:
  //   T-30,T-28,T-26  |  gap  |  T-5,T-3,T-1,T-0
  // active ≈ 4 min (early) + 5 min (late) = ~9 min; the 20-min hole is dropped
  const times = [
    now - 30 * 60_000, now - 28 * 60_000, now - 26 * 60_000,
    now - 5 * 60_000, now - 3 * 60_000, now - 1 * 60_000, now,
  ];
  const mins = activeMinutes(times, {
    now,
    lookbackMs: 60 * 60_000,
    idleGapMs: 5 * 60_000,
  });
  assert.ok(mins >= 8 && mins <= 10, `expected ~9 active min, got ${mins}`);
});

test('burnRate: warming up until ≥10 min coverage; idle when no burn', () => {
  const now = Date.parse('2026-07-16T18:00:00Z');
  const short = burnRate(
    [{ at: now - 3 * 60_000, weighted: 1000 }, { at: now, weighted: 1000 }],
    { now },
  );
  assert.equal(short.warmingUp, true);
  assert.equal(short.burnPerMin, null);

  // Steady burn over 20 active minutes, 20k weighted total in window
  const samples = [];
  for (let i = 20; i >= 0; i--) {
    samples.push({ at: now - i * 60_000, weighted: 1000 });
  }
  const ready = burnRate(samples, { now });
  assert.equal(ready.warmingUp, false);
  assert.ok(ready.burnPerMin > 900 && ready.burnPerMin < 1100, `burn=${ready.burnPerMin}`);
  assert.ok(ready.activeMin >= 19 && ready.activeMin <= 21);

  const idle = burnRate([{ at: now - 30 * 60_000, weighted: 0 }], { now });
  assert.equal(idle.idle, true);
  assert.equal(idle.burnPerMin, 0);
});

// --- ETA band ---

test('etaBand returns range; suppresses Infinity when burn≈0', () => {
  const idle = etaBand({ used: 50_000, ceiling: 100_000, burnCurrent: 0, burnEwma: 0 });
  assert.equal(idle, null);

  const band = etaBand({
    used: 50_000,
    ceiling: 100_000,
    burnCurrent: 2000, // 25 min remaining at current
    burnEwma: 1000,    // 50 min at ewma
    ceilingPess: 90_000, // 20 min at current against pess ceiling
  });
  assert.ok(band);
  assert.ok(band.loMs < band.hiMs);
  assert.ok(band.loMs > 0);
});

// --- ladder ---

test('ladderUsage: exact → calibrated → estimated; never bare %', () => {
  const exact = ladderUsage({ exactPct: 64.2, used: null, ceiling: null, stopCount: 0 });
  assert.equal(exact.tier, 'exact');
  assert.equal(exact.pct, 64.2);
  assert.match(fmtUsageProvenance(exact), /\(exact\)/);

  const cal = ladderUsage({ exactPct: null, used: 64_000, ceiling: 100_000, stopCount: 4 });
  assert.equal(cal.tier, 'calibrated');
  assert.equal(cal.pct, 64);
  assert.match(fmtUsageProvenance(cal), /calibrated from 4 stops/);

  const est = ladderUsage({ exactPct: null, used: 12_000, ceiling: null, stopCount: 0 });
  assert.equal(est.tier, 'estimated');
  assert.equal(est.pct, null);
  assert.match(fmtUsageProvenance(est), /estimated/);
  assert.match(fmtUsageProvenance(est), /calibrating/);
});

// --- warn thresholds ---

test('parseUsageWarnAt: defensive; garbage → default, never silently off', () => {
  assert.deepEqual(parseUsageWarnAt('80,95'), [80, 95]);
  assert.deepEqual(parseUsageWarnAt('90'), [90]);
  assert.deepEqual(parseUsageWarnAt('nope'), DEFAULT_USAGE_WARN_AT);
  assert.deepEqual(parseUsageWarnAt(''), DEFAULT_USAGE_WARN_AT);
  assert.deepEqual(parseUsageWarnAt(null), DEFAULT_USAGE_WARN_AT);
  assert.deepEqual(parseUsageWarnAt('0,150,-5,abc,88'), [88]);
});

test('warn dedup: fire once per window instance; re-arm on resets_at change; debounce', () => {
  const store = { fired: {}, pending: {} };
  const key = warnKeysFor({ agent: 'claude', limitType: '5h', resetsAt: 1000, threshold: '80' });
  // first tick crosses → pending only (timestamped so pruneWarnKeys can expire it)
  assert.equal(shouldFireWarn(store, key, true), false);
  assert.ok(Number.isFinite(store.pending[key]));
  // second tick still crossed → fire
  assert.equal(shouldFireWarn(store, key, true), true);
  recordWarnFired(store, key);
  // third tick → already fired
  assert.equal(shouldFireWarn(store, key, true), false);
  // drop below → clear pending (already fired stays until re-arm)
  assert.equal(shouldFireWarn(store, key, false), false);
  // new resets_at re-arms
  const key2 = warnKeysFor({ agent: 'claude', limitType: '5h', resetsAt: 2000, threshold: '80' });
  assert.equal(shouldFireWarn(store, key2, true), false);
  assert.equal(shouldFireWarn(store, key2, true), true);
});

// --- calibration ---

test('medianCeiling from recent stops; ring bounded; formulaV stored', () => {
  const state = { version: 1, sessions: {}, calibration: {} };
  for (let i = 0; i < 25; i++) {
    appendCalibration(state, {
      at: 1000 + i,
      agent: 'claude',
      limitType: '5h',
      windowStart: 0,
      weightedTokens: 80_000 + i * 1000,
      formulaV: TOKEN_WEIGHT_FORMULA_V,
      resetAt: 9999,
    });
  }
  const ring = state.calibration['claude:5h'];
  assert.equal(ring.length, 20); // bounded
  assert.equal(ring[0].weightedTokens, 80_000 + 5 * 1000); // oldest dropped
  assert.equal(ring[ring.length - 1].formulaV, TOKEN_WEIGHT_FORMULA_V);

  // median of last 5: values 100k,101k,102k,103k,104k → 102k
  const med = medianCeiling(state.calibration, 'claude', '5h', 5);
  assert.equal(med, 102_000);
});

test('smoothUsedPercent clamps stale/>100 spikes', () => {
  assert.equal(smoothUsedPercent(105, 90), 100);
  assert.equal(smoothUsedPercent(50, 90), 50); // drop is fine
  assert.equal(smoothUsedPercent(null, 40), 40);
  assert.equal(smoothUsedPercent(12, null), 12);
});

// --- extractors ---

test('extractClaudeUsage skips synthetic/zero; weights usage; captures model pool', () => {
  const ts = '2026-07-16T12:00:00.000Z';
  // Real CC transcripts put model on message.model; top-level model is often null.
  const good = extractClaudeUsage(JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    model: null,
    message: {
      model: 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 5000,
      },
    },
  }));
  assert.ok(good);
  assert.equal(good.at, Date.parse(ts));
  assert.equal(good.weighted, 1000 + 200 + 500); // cache_read * 0.1
  assert.equal(good.modelPool, 'sonnet');

  assert.equal(extractClaudeUsage(JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: {
      model: '<synthetic>',
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  })), null);

  assert.equal(extractClaudeUsage(JSON.stringify({
    type: 'user',
    timestamp: ts,
    message: { content: 'hi' },
  })), null);

  assert.equal(extractClaudeUsage('{{'), null);
});

test('extractCodexUsage: %-space snapshots; null secondary; 43200-min label; resets_at seconds', () => {
  const ts = '2026-07-16T12:00:00.000Z';
  const sample = extractCodexUsage(JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1_778_672_230 },
        secondary: null,
        plan_type: 'go',
      },
    },
  }));
  assert.ok(sample);
  assert.equal(sample.at, Date.parse(ts));
  assert.equal(sample.primary.usedPercent, 12.5);
  assert.equal(sample.primary.windowMinutes, 300);
  assert.equal(sample.primary.resetsAtMs, 1_778_672_230_000);
  assert.equal(sample.primary.label, '5h');
  assert.equal(sample.secondary, null);

  const monthly = extractCodexUsage(JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 5, window_minutes: 300, resets_at: 100 },
        secondary: { used_percent: 5, window_minutes: 43200, resets_at: 200 },
      },
    },
  }));
  assert.equal(monthly.secondary.label, '30d');
  assert.equal(extractCodexUsage(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } })), null);
});

// --- formatting ---

test('asciiBar and fmtDuration are plain-ASCII and finite', () => {
  assert.equal(asciiBar(50, 20).length, 20);
  assert.match(asciiBar(0, 10), /^░+$/);
  assert.match(asciiBar(100, 10), /^█+$/);
  assert.equal(fmtDuration(90_000), '2m');
  assert.equal(fmtDuration(3_600_000 + 600_000), '1h 10m');
  assert.equal(fmtDuration(null), null);
});

test('formatUsageText includes ladder labels and lower-bound disclaimer', () => {
  const text = formatUsageText({
    daemonRunning: true,
    warnAt: [80, 95],
    agents: [
      {
        agent: 'claude',
        windows: [
          {
            label: '5h',
            ladder: { tier: 'calibrated', pct: 64, stopCount: 4, used: 64000, ceiling: 100000 },
            burn: { burnPerMin: 31_000, activeMin: 42, idle: false, warmingUp: false },
            eta: { loMs: 60 * 60_000, hiMs: 80 * 60_000 },
            resetsAtMs: Date.parse('2026-07-16T20:00:00'),
            resetSource: 'absolute',
          },
          {
            label: 'weekly',
            ladder: { tier: 'exact', pct: 41, stopCount: 0 },
            burn: null,
            eta: null,
            resetsAtMs: Date.parse('2026-07-19T18:30:00'),
            infoOnly: true,
          },
        ],
      },
      {
        agent: 'codex',
        windows: [
          {
            label: '5h',
            ladder: { tier: 'exact', pct: 5, stopCount: 0 },
            burn: { idle: true, burnPerMin: 0, activeMin: 0, warmingUp: false },
            eta: null,
            resetsAtMs: null,
          },
        ],
      },
    ],
  });
  assert.match(text, /calibrated from 4 stops/);
  assert.match(text, /\(exact\)/);
  assert.match(text, /idle — no active burn/);
  assert.match(text, /lower bound/i);
  assert.match(text, /--install-statusline/);
});

// --- usage store + state calibration wiring ---

test('usage store atomic read/write', () => {
  writeUsageStore({ samples: [], fired: {}, pending: {}, version: 1 });
  const s = readUsageStore();
  assert.equal(s.version, 1);
  assert.ok(Array.isArray(s.samples));
});

test('appendCalibration rides state and survives prune of sessions', () => {
  updateState(state => {
    appendCalibration(state, {
      at: Date.now(),
      agent: 'claude',
      limitType: '5h',
      windowStart: Date.now() - 5 * 3_600_000,
      weightedTokens: 95_000,
      formulaV: 1,
      resetAt: Date.now() + 60_000,
    });
    return state;
  });
  const state = readState();
  assert.ok(state.calibration['claude:5h']?.length >= 1);
  assert.equal(state.calibration['claude:5h'][0].weightedTokens, 95_000);
});

test('buildUsageReport combines exact codex with calibrated claude', () => {
  const now = Date.parse('2026-07-16T18:00:00Z');
  const claudeSamples = [];
  for (let i = 40; i >= 0; i--) {
    claudeSamples.push({
      agent: 'claude',
      at: now - i * 60_000,
      weighted: 1000,
      modelPool: 'sonnet',
    });
  }
  const codexSamples = [
    {
      agent: 'codex',
      at: now - 5 * 60_000,
      primary: { usedPercent: 5, windowMinutes: 300, resetsAtMs: now + 4 * 3_600_000, label: '5h' },
      secondary: { usedPercent: 5, windowMinutes: 43200, resetsAtMs: now + 20 * 86_400_000, label: '30d' },
    },
    {
      agent: 'codex',
      at: now,
      primary: { usedPercent: 5, windowMinutes: 300, resetsAtMs: now + 4 * 3_600_000, label: '5h' },
      secondary: { usedPercent: 5, windowMinutes: 43200, resetsAtMs: now + 20 * 86_400_000, label: '30d' },
    },
  ];
  const calibration = {
    'claude:5h': [
      { weightedTokens: 100_000, formulaV: 1, at: now - 86_400_000 },
      { weightedTokens: 110_000, formulaV: 1, at: now - 2 * 86_400_000 },
      { weightedTokens: 105_000, formulaV: 1, at: now - 3 * 86_400_000 },
    ],
  };
  const report = buildUsageReport({
    now,
    claudeSamples,
    codexSamples,
    calibration,
    exactClaude: null,
  });
  const claude = report.agents.find(a => a.agent === 'claude');
  const codex = report.agents.find(a => a.agent === 'codex');
  assert.ok(claude);
  assert.equal(claude.windows[0].ladder.tier, 'calibrated');
  assert.ok(claude.windows[0].ladder.pct > 0);
  assert.equal(codex.windows[0].ladder.tier, 'exact');
  assert.equal(codex.windows[0].ladder.pct, 5);
  assert.equal(codex.windows.find(w => w.label === '30d')?.ladder.pct, 5);
});

test('seedUsageFromSamples keeps only recent window samples', () => {
  const now = Date.now();
  const samples = [
    { agent: 'claude', at: now - 3 * 3_600_000, weighted: 1 },
    { agent: 'claude', at: now - 30 * 60_000, weighted: 2 },
  ];
  const seeded = seedUsageFromSamples(samples, { now, keepMs: 2 * 3_600_000 });
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].weighted, 2);
});

// --- statusline shim + warn message ---

test('statusline shim chains and is removable without clobbering unknown settings', () => {
  const settingsPath = join(DIR, 'claude-settings.json');
  const shimDir = join(DIR, 'claude-unsnooze');
  writeFileSync(settingsPath, JSON.stringify({
    statusLine: { type: 'command', command: 'echo hello' },
    other: true,
  }, null, 2));
  const r = installStatuslineShim({ settingsPath, shimDir });
  assert.equal(r.ok, true);
  const after = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  assert.equal(after.other, true);
  assert.match(after.statusLine.command, /statusline-shim\.js/);
  assert.match(after.statusLine.command, /UNSNOOZE_STATUSLINE_ORIG/);

  const r2 = installStatuslineShim({ settingsPath, shimDir });
  assert.equal(r2.already, true);

  const u = uninstallStatuslineShim({ settingsPath, shimDir });
  assert.equal(u.removed, true);
  const restored = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  assert.equal(restored.statusLine.command, 'echo hello');
});

test('formatWarnMessage nudges /compact notify-only', () => {
  const msg = formatWarnMessage({
    agent: 'claude',
    label: '5h',
    pct: 86,
    ladder: { tier: 'calibrated', stopCount: 4 },
    eta: { loMs: 25 * 60_000, hiMs: 30 * 60_000 },
  }, { ctxTokens: 152_000 });
  assert.match(msg, /claude 5h/);
  assert.match(msg, /86%/);
  assert.match(msg, /calibrated from 4 stops/);
  assert.match(msg, /\/compact now/);
  assert.match(msg, /152k/);
});

test('prepareCalibrationSample cold-builds ceiling without daemon store', () => {
  const now = Date.parse('2026-07-16T18:00:00Z');
  const samples = [];
  for (let i = 30; i >= 0; i--) {
    samples.push({
      agent: 'claude', at: now - i * 60_000, weighted: 2000, modelPool: 'sonnet',
    });
  }
  const sample = prepareCalibrationSample({
    agent: 'claude',
    limitType: '5h',
    resetAtMs: now + 60 * 60_000,
    now,
    samples,
  });
  assert.ok(sample);
  assert.ok(sample.weightedTokens > 0);
  assert.equal(sample.formulaV, TOKEN_WEIGHT_FORMULA_V);
  assert.equal(sample.modelPool, 'sonnet');
  assert.equal(sample.key, calibrationKey('claude', '5h', 'sonnet'));
  // Apply under state lock path
  updateState(state => applyCalibrationToState(state, sample));
  const state = readState();
  assert.ok(state.calibration[sample.key]?.length >= 1);
});

test('evaluateUsageWarnings fires once per threshold with debounce', () => {
  const store = { fired: {}, pending: {} };
  const report = {
    agents: [{
      agent: 'claude',
      windows: [{
        label: '5h',
        ladder: { tier: 'exact', pct: 96, stopCount: 0 },
        eta: { loMs: 8 * 60_000, hiMs: 10 * 60_000 },
        resetsAtMs: 999,
        infoOnly: false,
      }],
    }],
  };
  const first = evaluateUsageWarnings(report, store, { warnAt: [80, 95], etaWarnMin: [30, 10] });
  assert.equal(first.length, 0); // debounce: pending only
  const second = evaluateUsageWarnings(report, store, { warnAt: [80, 95], etaWarnMin: [30, 10] });
  assert.ok(second.length >= 2); // 80, 95, maybe eta tiers
  const third = evaluateUsageWarnings(report, store, { warnAt: [80, 95], etaWarnMin: [30, 10] });
  assert.equal(third.length, 0); // deduped
});

test('extractClaudeUsage skips isSidechain to avoid parent+subagent double-count', () => {
  const ts = '2026-07-16T12:00:00.000Z';
  assert.equal(extractClaudeUsage(JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    isSidechain: true,
    message: {
      model: 'claude-sonnet-4',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
    },
  })), null);
});

test('pctSpaceEta: exact-tier burn = d(pct)/dt, ETA band, idle, warming up', () => {
  const now = Date.parse('2026-07-16T18:00:00Z');
  assert.equal(pctSpaceEta([], { now }).warmingUp, true);

  const short = pctSpaceEta([
    { at: now - 5 * 60_000, pct: 50 },
    { at: now, pct: 55 },
  ], { now });
  assert.equal(short.warmingUp, true);

  const idle = pctSpaceEta([
    { at: now - 20 * 60_000, pct: 60 },
    { at: now, pct: 60.02 },
  ], { now });
  assert.equal(idle.idle, true);

  // 40% → 60% over 20 active min → 1 %/min → 40 min to wall
  const reset = now + 3 * 3_600_000;
  const burning = pctSpaceEta([
    { at: now - 20 * 60_000, pct: 40, resetsAtMs: reset },
    { at: now - 10 * 60_000, pct: 50, resetsAtMs: reset },
    { at: now, pct: 60, resetsAtMs: reset },
  ], { now });
  assert.equal(burning.idle, false);
  assert.ok(burning.burnPerMin > 0.9 && burning.burnPerMin < 1.1);
  assert.ok(burning.eta.loMs > 0 && burning.eta.hiMs >= burning.eta.loMs);
  // remaining 40% / 1%/min ≈ 40 min
  assert.ok(burning.eta.hiMs < 50 * 60_000);
});

test('recordExactPctSample rings history; usageExitCode is terraform-style', () => {
  const store = { exactPct: { claude5h: [] } };
  const now = Date.now();
  recordExactPctSample(store, {
    fiveHour: { used_percentage: 50, resets_at: Math.floor(now / 1000) + 3600 },
  }, { now });
  recordExactPctSample(store, {
    fiveHour: { used_percentage: 50, resets_at: Math.floor(now / 1000) + 3600 },
  }, { now: now + 5_000 }); // deduped
  assert.equal(store.exactPct.claude5h.length, 1);
  recordExactPctSample(store, {
    fiveHour: { used_percentage: 55, resets_at: Math.floor(now / 1000) + 3600 },
  }, { now: now + 60_000 });
  assert.equal(store.exactPct.claude5h.length, 2);

  assert.equal(usageExitCode({
    warnAt: [80, 95],
    agents: [{ windows: [{ infoOnly: false, ladder: { pct: 50 } }] }],
  }), 0);
  assert.equal(usageExitCode({
    warnAt: [80, 95],
    agents: [{ windows: [{ infoOnly: false, ladder: { pct: 96 } }] }],
  }), 2);
  assert.equal(usageExitCode({
    warnAt: [80, 95],
    agents: [{ windows: [{ infoOnly: true, ladder: { pct: 99 } }] }],
  }), 0);
});

test('buildUsageReport uses exactPctHistory for Claude %-space ETA', () => {
  const now = Date.parse('2026-07-16T18:00:00Z');
  const history = [
    { at: now - 20 * 60_000, pct: 70, resetsAtMs: now + 2 * 3_600_000 },
    { at: now, pct: 80, resetsAtMs: now + 2 * 3_600_000 },
  ];
  const report = buildUsageReport({
    now,
    claudeSamples: [],
    codexSamples: [],
    calibration: {},
    exactClaude: { fiveHour: { used_percentage: 80, resets_at: (now + 2 * 3_600_000) / 1000 } },
    exactPctHistory: history,
  });
  const w = report.agents.find(a => a.agent === 'claude').windows[0];
  assert.equal(w.ladder.tier, 'exact');
  assert.equal(w.ladder.pct, 80);
  assert.equal(w.burn.unit, 'pct');
  assert.ok(w.eta && w.eta.loMs > 0);
});

test('cold collectClaudeSamples only tail-reads mtime-recent matching files', () => {
  const root = join(DIR, 'projects-perf');
  const proj = join(root, 'proj');
  mkdirSync(proj, { recursive: true });
  const oldId = '11111111-1111-1111-1111-111111111111.jsonl';
  const newId = '22222222-2222-2222-2222-222222222222.jsonl';
  const junk = join(proj, 'not-a-session.jsonl');
  const oldPath = join(proj, oldId);
  const newPath = join(proj, newId);
  writeFileSync(junk, '{}\n');
  writeFileSync(oldPath, JSON.stringify({
    type: 'assistant', timestamp: new Date(Date.now() - 10 * 3_600_000).toISOString(),
    message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 1 } },
  }) + '\n');
  writeFileSync(newPath, JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(),
    message: { model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 1 } },
  }) + '\n');
  // Age the old file so mtime-filter skips it
  const oldTime = new Date(Date.now() - 10 * 3_600_000);
  utimesSync(oldPath, oldTime, oldTime);

  const touched = [];
  collectClaudeSamples({
    roots: [root],
    now: Date.now(),
    lookbackMs: 2 * 3_600_000,
    onFile: p => touched.push(p),
  });
  assert.ok(touched.every(p => p.endsWith(newId) || !p.includes(oldId)));
  assert.ok(touched.some(p => p.endsWith(newId)));
  assert.ok(!touched.some(p => p.endsWith(oldId)));
  assert.ok(!touched.some(p => p.endsWith('not-a-session.jsonl')));
});

// --- gaps closed after the 1.13 verification sweep ---

test('collectClaudeSamples includes subagents/agent-*.jsonl in the burn sum', () => {
  const root = join(DIR, 'projects-sub');
  const sess = join(root, 'proj', '33333333-3333-3333-3333-333333333333', 'subagents');
  mkdirSync(sess, { recursive: true });
  const subPath = join(sess, 'agent-abc123.jsonl');
  writeFileSync(subPath, JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(),
    message: { model: 'claude-sonnet-4', usage: { input_tokens: 500, output_tokens: 100 } },
  }) + '\n');

  const touched = [];
  const samples = collectClaudeSamples({
    roots: [root], now: Date.now(), lookbackMs: 3_600_000, onFile: p => touched.push(p),
  });
  assert.ok(touched.some(p => p.endsWith('agent-abc123.jsonl')), 'subagent file tail-read');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].weighted, 600);

  // includeSubagents:false excludes it
  const none = collectClaudeSamples({ roots: [root], now: Date.now(), lookbackMs: 3_600_000, includeSubagents: false });
  assert.equal(none.length, 0);
});

test('buildUsageReport: codex %-space burn + ETA band, capped at resets_at', () => {
  const now = Date.now();
  const resetsAtMs = now + 40 * 60_000;
  const mkSample = (at, pct) => ({
    at, agent: 'codex',
    primary: { usedPercent: pct, windowMinutes: 300, resetsAtMs },
    secondary: { usedPercent: 5, windowMinutes: 10080, resetsAtMs: now + 3 * 86_400_000 },
  });
  // 10pp over 20min stays under the >15pp spike smoothing
  const report = buildUsageReport({
    now,
    claudeSamples: [],
    codexSamples: [mkSample(now - 20 * 60_000, 70), mkSample(now, 80)],
    calibration: {},
  });
  const codex = report.agents.find(a => a.agent === 'codex');
  const primary = codex.windows.find(w => w.label === '5h');
  assert.equal(primary.burn.unit, 'pct');
  assert.ok(Math.abs(primary.burn.burnPerMin - 0.5) < 0.01, '10pp over 20min = 0.5 pp/min');
  // 20% remaining at 0.5pp/min ≈ 40min; band 0.85–1.15× but hi is capped at the
  // 40-min resets_at — the cross-check the plan demands
  assert.ok(primary.eta.loMs >= 33 * 60_000 && primary.eta.loMs <= 35 * 60_000);
  assert.equal(primary.eta.hiMs, resetsAtMs - now);
  // weekly secondary is info-only, no ETA
  const weekly = codex.windows.find(w => w.label === 'weekly');
  assert.equal(weekly.infoOnly, true);
  assert.equal(weekly.eta, null);
});

test('usageReportToJson: stable v1 machine shape', () => {
  const now = Date.now();
  const report = buildUsageReport({
    now,
    claudeSamples: [],
    codexSamples: [{
      at: now, agent: 'codex',
      primary: { usedPercent: 42, windowMinutes: 300, resetsAtMs: now + 3_600_000 },
      secondary: null,
    }],
    calibration: {},
  });
  report.daemonRunning = false;
  report.warnAt = [80, 95];
  const j = usageReportToJson(report);
  assert.equal(j.version, 1);
  assert.equal(typeof j.now, 'number');
  assert.equal(j.daemonRunning, false);
  assert.deepEqual(j.warnAt, [80, 95]);
  const agent = j.agents.find(a => a.agent === 'codex');
  const w = agent.windows[0];
  for (const key of ['label', 'tier', 'pct', 'used', 'ceiling', 'stopCount', 'provenance',
    'burnPerMin', 'activeMin', 'idle', 'warmingUp', 'etaLoMs', 'etaHiMs', 'resetsAtMs', 'infoOnly']) {
    assert.ok(key in w, `window key ${key}`);
  }
  assert.equal(w.tier, 'exact');
  assert.equal(w.pct, 42);
  // Round-trips through JSON without loss
  assert.deepEqual(JSON.parse(JSON.stringify(j)), j);
});

test('pruneWarnKeys: expired fired/pending keys and legacy booleans are dropped', () => {
  const now = Date.now();
  const store = {
    fired: {
      'claude:5h:123:80': now - 9 * 24 * 3_600_000,  // stale
      'claude:5h:456:80': now - 3_600_000,           // fresh
    },
    pending: {
      'codex:5h:789:95': true,                        // legacy boolean → expired
      'codex:5h:999:95': now - 60_000,                // fresh
    },
  };
  pruneWarnKeys(store, now);
  assert.deepEqual(Object.keys(store.fired), ['claude:5h:456:80']);
  assert.deepEqual(Object.keys(store.pending), ['codex:5h:999:95']);
});

test('minCeiling: lowest recent observed stop; null below 2 samples', () => {
  const state = { calibration: {} };
  appendCalibration(state, { agent: 'claude', limitType: '5h', at: 1, weightedTokens: 900_000 });
  assert.equal(minCeiling(state.calibration, 'claude', '5h'), null, 'one sample adds no info');
  appendCalibration(state, { agent: 'claude', limitType: '5h', at: 2, weightedTokens: 700_000 });
  appendCalibration(state, { agent: 'claude', limitType: '5h', at: 3, weightedTokens: 1_100_000 });
  assert.equal(minCeiling(state.calibration, 'claude', '5h'), 700_000);
  const med = medianCeiling(state.calibration, 'claude', '5h');
  assert.equal(med, 900_000);
});

test('cmdUsage --json e2e: exit 0, stable JSON, no state mutation', () => {
  const home = mkdtempSync(join(tmpdir(), 'unsnooze-usage-e2e-'));
  const stateDir = join(home, '.unsnooze');
  mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, 'state.json');
  const before = JSON.stringify({ v: 1, sessions: {}, calibration: {} });
  writeFileSync(statePath, before);
  const env = {
    ...process.env,
    UNSNOOZE_STATE_DIR: stateDir,
    UNSNOOZE_CLAUDE_DIR: join(home, '.claude'),
    UNSNOOZE_CODEX_DIR: join(home, '.codex'),
    NO_COLOR: '1',
  };
  const out = execFileSync(process.execPath, ['bin/unsnooze.js', 'usage', '--json'], {
    env, encoding: 'utf-8',
  });
  const j = JSON.parse(out);
  assert.equal(j.version, 1);
  assert.ok(Array.isArray(j.agents));
  // Read-only command: state.json byte-identical, usage.json not created
  assert.equal(readFileSync(statePath, 'utf-8'), before);
  assert.ok(!existsSync(join(stateDir, 'usage.json')));
  rmSync(home, { recursive: true, force: true });
});
