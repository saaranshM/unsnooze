// Toggle enforcement: autoResume, menuAutoAnswer, resume-now manual override.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-toggles-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');

const { createMonitor } = await import('../src/monitor.js');
const { dueForDispatch } = await import('../src/resumer.js');
const { cmdResumeNow } = await import('../src/cli.js');
const { upsertSession, readState } = await import('../src/state.js');

after(() => rmSync(DIR, { recursive: true, force: true }));
beforeEach(() => {
  delete process.env.UNSNOOZE_AUTO_RESUME;
  delete process.env.UNSNOOZE_MENU_AUTO_ANSWER;
});

const MENU = [
  'What do you want to do?',
  '❯ 1. Upgrade your plan',
  '  2. Stop and wait for limit to reset',
  '(enter to confirm)',
].join('\n');

function fakeTmux(script) {
  const sent = [];
  return {
    sent,
    paneAlive: async () => true,
    capturePane: async () => script.text,
    sendText: async (pane, text) => sent.push({ type: 'text', text }),
    sendKey: async (pane, key) => sent.push({ type: 'key', key }),
  };
}

function seedStopped(pane, extra = {}) {
  const state = upsertSession({
    sessionId: null, cwd: '/tmp/x', pane, tmuxSession: 'unsnooze-test',
    status: 'stopped', limitType: '5h', detectedVia: 'scrape',
    detectedAt: Date.now() - 3_600_000, resetAt: Date.now() - 1000,
    resetSource: 'absolute', attempts: 0, lastAttemptAt: null, lastError: null,
    ...extra,
  });
  return Object.values(state.sessions).find(s => s.pane === pane);
}

test('menuAutoAnswer off → menu NOT driven, stop still recorded', async () => {
  process.env.UNSNOOZE_MENU_AUTO_ANSWER = 'off';
  const tmux = fakeTmux({ text: MENU });
  const monitor = createMonitor({ pane: '%70', cwd: '/tmp/proj-menu', tmux });
  await monitor._tick();
  assert.equal(tmux.sent.length, 0, 'no keys may be sent when the toggle is off');
  const recs = Object.values(readState().sessions).filter(s => s.pane === '%70');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].status, 'stopped');
});

test('menuAutoAnswer on (default) → menu driven as before', async () => {
  const tmux = fakeTmux({ text: MENU });
  const monitor = createMonitor({ pane: '%71', cwd: '/tmp/proj-menu2', tmux });
  await monitor._tick();
  assert.deepEqual(tmux.sent.map(s => s.key), ['Down', 'Enter']);
});

test('autoResume off → due sessions are not dispatchable', () => {
  seedStopped('%72');
  process.env.UNSNOOZE_AUTO_RESUME = 'off';
  assert.equal(dueForDispatch().filter(s => s.pane === '%72').length, 0);
  delete process.env.UNSNOOZE_AUTO_RESUME;
  assert.equal(dueForDispatch().filter(s => s.pane === '%72').length, 1);
});

test('resume-now marks manual and bypasses autoResume off', () => {
  const rec = seedStopped('%73');
  process.env.UNSNOOZE_AUTO_RESUME = 'off';
  cmdResumeNow(rec.key);
  const after1 = readState().sessions[rec.key];
  assert.equal(after1.manual, true);
  assert.ok(dueForDispatch().some(s => s.key === rec.key), 'manual sessions dispatch even when autoResume is off');
});
