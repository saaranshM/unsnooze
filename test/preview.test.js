// `unsnooze preview` — dry-run: what would the resumer do, right now, and
// why? Decision logic is SHARED with dispatchOne (planFor/assessPane/
// evaluateGuards) so preview can never drift from what dispatch actually
// does. Preview performs read-only pane captures but must never mutate
// state, send keys, or open windows.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-preview-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';

const { planFor } = await import('../src/resumer.js');
const { cmdPreview } = await import('../src/cli.js');
const { upsertSession, readState } = await import('../src/state.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

let n = 0;
function seed(overrides = {}) {
  n += 1;
  const rec = {
    sessionId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    cwd: '/tmp/proj', pane: overrides.pane === null ? null : (overrides.pane || `%${n}`),
    mux: 'tmux', paneOwner: null,
    status: 'stopped', limitType: '5h', detectedVia: 'hook',
    detectedAt: Date.now() - 3_600_000, resetAt: Date.now() - 1000,
    resetSource: 'absolute', attempts: 0, agent: 'claude',
    ...overrides,
  };
  const state = upsertSession(rec);
  return Object.values(state.sessions).find(s => s.sessionId === rec.sessionId);
}

const liveClaudePane = (stamp = null) => ({
  paneAlive: async () => true,
  capturePane: async () => '❯ ',
  paneCurrentCommand: async () => 'claude',
  paneOwnerStamp: async () => stamp,
  sessionExists: async () => false,
});

test('due session with a live owned claude pane → plan: inject, with the exact message', async () => {
  const rec = seed({});
  const plan = await planFor(rec, { mux: liveClaudePane(), matchesLease: async () => true });
  assert.equal(plan.action, 'inject');
  assert.equal(plan.target.pane, rec.pane);
  assert.match(plan.message, /Continue where you left off/, 'default resume message resolved');
});

test('not-due session → waiting, with the gate explained; nothing actionable', async () => {
  const rec = seed({ resetAt: Date.now() + 3_600_000 });
  const plan = await planFor(rec, { mux: liveClaudePane(), matchesLease: async () => true });
  assert.equal(plan.action, 'waiting');
  assert.ok(plan.gates.some(g => /resets/.test(g)), `gates must show the countdown: ${plan.gates}`);
});

test('autoResume off (and not manual) → paused gate', async () => {
  process.env.UNSNOOZE_AUTO_RESUME = 'off';
  try {
    const rec = seed({});
    const plan = await planFor(rec, { mux: liveClaudePane(), matchesLease: async () => true });
    assert.equal(plan.action, 'paused');
  } finally {
    delete process.env.UNSNOOZE_AUTO_RESUME;
  }
});

test('workspace change under inform is reflected in the exact typed message', async () => {
  const rec = seed({ workspace: { head: 'aaa', dirty: false } });
  const plan = await planFor(rec, {
    mux: liveClaudePane(), matchesLease: async () => true,
    fingerprint: () => ({ head: 'bbb', dirty: false }),
  });
  assert.equal(plan.action, 'inject');
  assert.match(plan.message, /Heads up: this workspace changed/,
    'preview must show the FINAL message, guard suffix included');
});

test('recycled pane (stamp mismatch) → plan: reopen into the revival session', async () => {
  const rec = seed({ leaseId: 'L-mine' });
  const mux = { ...liveClaudePane('L-other') };
  const plan = await planFor(rec, { mux, matchesLease: async () => false });
  assert.equal(plan.action, 'reopen');
  assert.match(plan.target.session, /unsnooze-resumed/);
});

test('busy pane → defer, no message shown as pending keystrokes', async () => {
  const rec = seed({});
  const mux = { ...liveClaudePane(), capturePane: async () => 'thinking… esc to interrupt' };
  const plan = await planFor(rec, { mux, matchesLease: async () => true });
  assert.equal(plan.action, 'busy');
});

test('fallback record → probe plan, not a resume', async () => {
  const rec = seed({ resetSource: 'fallback', resetAt: Date.now() + 60_000 });
  const plan = await planFor(rec, { mux: liveClaudePane(), matchesLease: async () => true });
  assert.equal(plan.action, 'probe');
});

test('planFor and cmdPreview never mutate state or touch the pane', async () => {
  const rec = seed({});
  const sent = [];
  const mux = {
    ...liveClaudePane(),
    sendText: async (...a) => sent.push(a),
    sendKey: async (...a) => sent.push(a),
    newWindow: async (...a) => { sent.push(a); return { pane: '%x' }; },
  };
  const before = JSON.stringify(readState().sessions[rec.key]);
  await planFor(rec, { mux, matchesLease: async () => true });
  const lines = [];
  await cmdPreview([], { resolveMux: () => mux, print: l => lines.push(l) });
  assert.equal(sent.length, 0, 'no keys typed, no windows opened');
  assert.equal(JSON.stringify(readState().sessions[rec.key]), before, 'record byte-identical');
});

test('cmdPreview exit codes: 2 when something would wake now, 0 when all waiting', async () => {
  // The seeds above include due+actionable records → 2.
  const lines = [];
  const code = await cmdPreview([], { resolveMux: () => liveClaudePane(), matchesLease: async () => true, print: l => lines.push(l) });
  assert.equal(code, 2, 'actionable wake present → exit 2 (terraform -detailed-exitcode style)');
  assert.ok(lines.some(l => /would/i.test(l)), 'speaks in the conditional — nothing was done');
});

test('give-up is only predicted when dispatch would actually reach it (due + dispatchable)', async () => {
  // runResumer's give-up loop iterates dueForDispatch(): a maxed-out record
  // in its backoff window (resetAt in the future) is WAITING, not abandoned —
  // and a paused one is PAUSED. Preview must narrate the same gating.
  const backingOff = seed({ attempts: 5, resetAt: Date.now() + 120_000 });
  const p1 = await planFor(backingOff, { mux: liveClaudePane(), matchesLease: async () => true });
  assert.equal(p1.action, 'waiting', 'backoff window → waiting, not give-up');

  process.env.UNSNOOZE_AUTO_RESUME = 'off';
  try {
    const paused = seed({ attempts: 5 });
    const p2 = await planFor(paused, { mux: liveClaudePane(), matchesLease: async () => true });
    assert.equal(p2.action, 'paused', 'paused beats give-up — dispatch never reaches the cap check');
  } finally {
    delete process.env.UNSNOOZE_AUTO_RESUME;
  }

  const due = seed({ attempts: 5, resetAt: Date.now() - 1000 });
  const p3 = await planFor(due, { mux: liveClaudePane(), matchesLease: async () => true });
  assert.equal(p3.action, 'give-up', 'due + dispatchable + maxed → genuinely gives up');
});

test('a fallback record past the probe ceiling predicts the real wake, not a probe', async () => {
  // rescheduleProbe deterministically stops probing at
  // detectedAt + FALLBACK_RESET_MS + RESET_MARGIN_MS and dispatch falls
  // through to a real resume — preview must say so (and exit 2).
  const rec = seed({
    resetSource: 'fallback',
    detectedAt: Date.now() - 6 * 3_600_000,   // far past the 5h ceiling
    resetAt: Date.now() - 1000,
  });
  const plan = await planFor(rec, { mux: liveClaudePane(), matchesLease: async () => true });
  assert.equal(plan.action, 'inject', 'ceiling reached → dispatch resumes; preview must match');
  assert.ok(plan.gates.some(g => /ceiling/.test(g)), 'the ceiling is named as the reason');
});
