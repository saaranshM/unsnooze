// Claude's own auto-continue (shipped 2026-08-14 in Claude Code desktop; the
// CLI carries the code behind a feature gate that currently defaults off).
//
// It resumes a limit-stopped session in-process when the window resets. Two
// resumers acting on one session would duplicate a turn and spend the fresh
// quota twice, so unsnooze has to notice and stand down.
//
// It already does: finishIfClaudeProgressed() gates every resume path, and the
// 60s RESET_MARGIN_MS means unsnooze acts a full minute after the reset that
// native auto-continue fires on. What was missing is saying so — a session that
// woke itself looked identical to one unsnooze woke.
//
// Scope of the native feature, read off the 2.1.233 bundle:
//   rateLimitType === "five_hour"   (weekly/seven-day is NOT covered)
//   && !isUsingOverage && errorCode !== "credits_required"

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-native-ac-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');
process.env.UNSNOOZE_VERIFY_DELAY_MS = '0';

const { dispatchOne } = await import('../src/resumer.js');
const { upsertSession, readState } = await import('../src/state.js');
const { transcriptPath } = await import('../src/sessions.js');
const { RESET_MARGIN_MS } = await import('../src/config.js');

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

let n = 0;
function seed(overrides = {}) {
  const rec = {
    sessionId: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    // Distinct pane per record: the ledger keys on it, so a shared '%1' makes
    // each test reuse the previous test's record and go 'stale'.
    cwd: join(DIR, 'proj'), pane: `%${n}`, mux: 'tmux', paneOwner: null,
    muxSession: 'unsnooze-test', agent: 'claude',
    status: 'stopped', limitType: '5h', detectedVia: 'hook',
    detectedAt: Date.now() - 3_600_000, bannerAt: Date.now() - 3_600_000,
    resetAt: Date.now() - 1000, resetSource: 'absolute', attempts: 0,
    ...overrides,
  };
  const state = upsertSession(rec);
  return Object.values(state.sessions).find(s => s.sessionId === rec.sessionId);
}

// Native auto-continue leaves the same trace any resumed turn does: fresh
// non-error usage on the parent context, after the stop.
function writeProgress(rec, atMs) {
  const path = transcriptPath(rec.cwd, rec.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    type: 'assistant',
    timestamp: new Date(atMs).toISOString(),
    message: { role: 'assistant', usage: { input_tokens: 2, output_tokens: 1 } },
  }) + '\n');
}

const liveMux = sent => ({
  paneAlive: async () => true,
  paneCurrentCommand: async () => 'claude',
  capturePane: async () => '❯ ',
  sendText: async (...args) => sent.push(args),
});

test('a session that resumed itself is left alone', async () => {
  const rec = seed();
  writeProgress(rec, rec.detectedAt + 1000);
  const sent = [];

  assert.equal(await dispatchOne(rec, { mux: liveMux(sent) }), 'already-resumed');
  assert.deepEqual(sent, [], 'nothing may be typed at a session already moving');
});

test('a self-resumed session is attributed to Claude, not to unsnooze', async () => {
  const rec = seed();
  writeProgress(rec, rec.detectedAt + 1000);

  await dispatchOne(rec, { mux: liveMux([]) });

  const saved = readState().sessions[rec.key];
  assert.equal(saved.status, 'resumed');
  assert.equal(saved.resumedBy, 'native',
    'the user must be able to tell "it woke itself" from "unsnooze woke it"');
});

test('a session unsnooze actually wakes is attributed to unsnooze', async () => {
  const rec = seed();   // no transcript progress — nothing resumed it
  const sent = [];

  const result = await dispatchOne(rec, { mux: liveMux(sent) });

  assert.equal(result, 'injected');
  assert.equal(sent.length, 1, 'unsnooze must still do its job when nothing else will');
  const saved = readState().sessions[rec.key];
  assert.equal(saved.resumedBy, 'unsnooze');
});

test('a weekly limit is still unsnooze\'s job — native only covers five_hour', async () => {
  // The single most important line of this file. Native auto-continue is gated
  // on rateLimitType === "five_hour"; nobody leaves an app open for three days,
  // and if unsnooze ever "deferred to native" on a weekly stop it would strand
  // the session for the whole window.
  const rec = seed({ limitType: 'weekly' });
  const sent = [];

  assert.equal(await dispatchOne(rec, { mux: liveMux(sent) }), 'injected');
  assert.equal(sent.length, 1);
});

test('unsnooze never fires before native auto-continue has had its chance', async () => {
  // Not an accident worth losing: RESET_MARGIN_MS exists for clock skew, but it
  // is also what makes unsnooze the second resumer rather than a racing one.
  // Shrinking it to "resume faster" would reintroduce the double-wake.
  assert.ok(RESET_MARGIN_MS >= 30_000,
    `reset margin is ${RESET_MARGIN_MS}ms — too short to let an in-process `
    + 'auto-continue land first, which is how the double-resume is avoided');
});
