// A model limit is lifted by a human, never by waiting — so the one thing
// unsnooze must never do is type a wake into a pane that is still limited.
// It would hit the same wall, consume an attempt, and look to the user like
// the tool is flailing at their terminal.
//
// The other half is honesty: `unsnooze preview` has to predict the same
// outcome dispatch produces, or it is worse than no preview.

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-model-lifecycle-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';

const { dispatchOne, planFor, probeFallback } = await import('../src/resumer.js');
const { upsertSession, readState, updateState } = await import('../src/state.js');
const { FALLBACK_RESET_MS, RESET_MARGIN_MS } = await import('../src/config.js');

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
beforeEach(() => updateState(state => { state.sessions = {}; return state; }));

const BANNER = "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.";

// A pane that still shows the banner, recording anything typed at it.
function limitedPane(sent) {
  return {
    paneAlive: async () => true,
    capturePane: async () => `${BANNER}\n`,
    capturePaneVisible: async () => `${BANNER}\n`,
    sendText: async (_pane, text) => { sent.push(text); },
    sendKey: async () => {},
    sessionForPane: async () => 'unsnooze',
    paneOwnerStamp: async () => 'lease-model',
  };
}

function seedModelStop({ detectedAt = Date.now(), probeCount = 0 } = {}) {
  const state = upsertSession({
    sessionId: 'model-limit-1', cwd: '/repo', pane: '%7', mux: 'tmux', paneOwner: null,
    muxSession: 'unsnooze', status: 'stopped', limitType: 'model', detectedVia: 'scrape',
    detectedAt, bannerAt: detectedAt, resetAt: detectedAt, resetSource: 'fallback',
    attempts: 0, lastAttemptAt: null, lastError: null, leaseId: 'lease-model', probeCount,
  });
  return Object.values(state.sessions).find(r => r.sessionId === 'model-limit-1');
}

test('before the ceiling: the record probes, and nothing is typed', async () => {
  const rec = seedModelStop();
  const sent = [];
  const result = await probeFallback(rec, { mux: limitedPane(sent) });
  assert.equal(result, 'probe', 'still probing');
  assert.deepEqual(sent, [], 'nothing typed into a limited pane');
});

test('at the ceiling: the record is held for a human, and STILL nothing is typed', async () => {
  // Old enough that the probe ceiling has passed.
  const old = Date.now() - (FALLBACK_RESET_MS + RESET_MARGIN_MS + 60_000);
  const rec = seedModelStop({ detectedAt: old, probeCount: 5 });
  const sent = [];

  const result = await dispatchOne(rec, {
    resolveMux: () => limitedPane(sent),
    mux: limitedPane(sent),
  });

  assert.notEqual(result, 'injected', `a still-limited pane must never be injected into (got ${result})`);
  assert.deepEqual(sent, [], 'no wake message was typed');
  const saved = readState().sessions[rec.key];
  assert.equal(saved.status, 'failed', 'the stall is visible rather than silent');
  assert.match(saved.lastError, /model limit/i);
  assert.match(saved.lastError, /\/model|credits/i, 'and says what the human has to do');
});

test('preview predicts the same hold, rather than promising a wake', async () => {
  const old = Date.now() - (FALLBACK_RESET_MS + RESET_MARGIN_MS + 60_000);
  const rec = seedModelStop({ detectedAt: old, probeCount: 5 });
  const sent = [];

  const plan = await planFor(rec, { mux: limitedPane(sent) });

  assert.notEqual(plan.action, 'inject',
    `preview must not promise a wake dispatch will not perform (got ${plan.action})`);
  assert.deepEqual(sent, [], 'preview never touches the pane');
});

test('a model record carries no reset time to schedule from', () => {
  const rec = seedModelStop();
  assert.equal(rec.limitType, 'model');
  assert.equal(rec.resetSource, 'fallback', 'it can only probe, never blind-wake');
});
