import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'unsnooze-codex-submit-'));
process.env.UNSNOOZE_STATE_DIR = dir;
process.env.UNSNOOZE_CLAUDE_DIR = join(dir, 'claude');
process.env.UNSNOOZE_CODEX_DIR = join(dir, 'codex');
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
const { pendingCodexPrompt } = await import('../src/agents/codex.js');
const { getAgent } = await import('../src/agents/index.js');
const { dispatchOne, verifyOne } = await import('../src/resumer.js');
const { createMonitor } = await import('../src/monitor.js');
const { upsertSession, readState, setStatus } = await import('../src/state.js');
after(() => rmSync(dir, { recursive: true, force: true }));

const message = 'Continue where you left off. Finish the task.';
const banner = '■ Your workspace is out of credits. Ask your workspace owner to refill in order to continue.';
const composer = msg => `${banner}\n\n› ${msg}\n\n  gpt-5.4 · /tmp/project · thread title\n`;

test('only the exact unsubmitted Codex composer authorizes a submit retry', () => {
  assert.ok(pendingCodexPrompt(composer('Continue where you left off.\n  Finish the task.\n'), message));
  assert.ok(pendingCodexPrompt(`\x1b[31m${composer(message)}\x1b[0m`, message));
  for (const text of [
    composer('my own draft'), composer(message + ' extra'),
    `› ${message}\n\n• Working (esc to interrupt)\n› \n\n  gpt-5.4 · /tmp/project`,
    `› ${message}\n\n• response\n\n  gpt-5.4 · /tmp/project`,
    composer(message) + '\n• response after the old footer',
    `› ${message}`, composer('[Pasted Content 4 lines]'),
  ]) assert.equal(pendingCodexPrompt(text, message), false, text);
});

// #62: a second footer row under the status bar must not hide the unsent draft.
test('a multi-row Codex footer still counts as an unsent composer', () => {
  const wake = 'Continue where you left off. The session was interrupted by a usage limit which has now reset — pick up the task you were working on and finish it.\n\nHeads up: this workspace changed while the session was stopped (HEAD 804701f → 01ace88; uncommitted changes differ). Re-read the current state of the repo before continuing.';
  const pane = [
    '■ You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more',
    'credits or try again at 3:12 AM.', '', '',
    '› Continue where you left off. The session was interrupted by a usage limit which has now reset — pick up the task you were working on and',
    '  finish it.', '',
    '  Heads up: this workspace changed while the session was stopped (HEAD 804701f → 01ace88; uncommitted changes differ). Re-read the current',
    '  state of the repo before continuing.', '', '',
    '  GPT-6-Luna max · /tmp/project · 5h 100% left · weekly 84% left · Context … Goal paused (/goal resume)',
    '                                                                                    ⚠ 9 warnings · f2 to view',
  ].join('\n');
  assert.ok(pendingCodexPrompt(pane, wake));
  assert.equal(pendingCodexPrompt(pane + '\n• response after the footer', wake), false);
});

let nextPane = 700;
async function sentDraft() {
  const pane = `%${nextPane++}`;
  const state = upsertSession({
    sessionId: `00000000-0000-4000-8000-${String(nextPane).padStart(12, '0')}`,
    agent: 'codex', cwd: dir, pane, paneOwner: null, mux: 'tmux', leaseId: null,
    status: 'stopped', limitType: '5h', detectedVia: 'watcher',
    detectedAt: Date.now() - 3600000, resetAt: Date.now() - 1000,
    resetSource: 'absolute', attempts: 0,
  });
  const rec = Object.values(state.sessions).find(s => s.pane === pane);
  let screen = '› \n', texts = 0, enters = 0;
  const mux = {
    paneAlive: async () => true, paneCurrentCommand: async () => 'codex',
    capturePane: async () => screen, capturePaneVisible: async () => screen,
    sendText: async (_pane, text) => { texts++; screen = composer(text); },
    sendKey: async (_pane, key) => { assert.equal(key, 'Enter'); enters++; },
  };
  assert.equal(await dispatchOne(rec, { mux, resumeMessage: message }), 'injected');
  return { rec, mux, screen: value => { screen = value; },
    counts: () => ({ texts, enters }), current: () => readState().sessions[rec.key] };
}

test('monitor preserves the episode; verification submits the draft once without retyping', async () => {
  const f = await sentDraft();
  const monitor = createMonitor({
    pane: f.rec.pane, cwd: dir, mux: f.mux, agent: getAgent('codex'),
    versionSkewed: () => false, spawner: () => { throw new Error('unexpected spawn'); },
  });
  const before = f.current();
  await monitor._tick();
  assert.deepEqual(f.current(), before, 'the old banner cannot become a newer stop');
  assert.equal(await verifyOne(f.rec.key, { resolveMux: () => f.mux }), 'pending');
  assert.deepEqual(f.counts(), { texts: 1, enters: 1 });
  assert.equal(f.current().status, 'resuming');
  assert.equal(f.current().attempts, 0);
  f.screen('• Continuing the task…\n');
  assert.equal(await verifyOne(f.rec.key, { resolveMux: () => f.mux }), 'resumed');
});

test('a permanently stalled composer receives at most three extra Enters, never duplicate text', async () => {
  const f = await sentDraft();
  for (let i = 0; i < 4; i++) await verifyOne(f.rec.key, { resolveMux: () => f.mux });
  assert.deepEqual(f.counts(), { texts: 1, enters: 3 });
  assert.equal(f.current().status, 'failed');
  assert.match(f.current().lastError, /wake prompt not submitted/);
});

test('submission recovery respects busy panes, ownership changes, and cancellation', async () => {
  const busy = await sentDraft();
  busy.screen(`• Working (esc to interrupt)\n${composer(message)}`);
  assert.equal(await verifyOne(busy.rec.key, { resolveMux: () => busy.mux }), 'pending');
  assert.equal(busy.counts().enters, 0);
  const recycled = await sentDraft();
  recycled.mux.paneOwnerStamp = async () => 'another-launch';
  assert.equal(await verifyOne(recycled.rec.key, { resolveMux: () => recycled.mux }), 'held');
  assert.equal(recycled.counts().enters, 0);
  const shell = await sentDraft();
  shell.mux.paneCurrentCommand = async () => 'zsh';
  assert.equal(await verifyOne(shell.rec.key, { resolveMux: () => shell.mux }), 'held');
  assert.equal(shell.counts().enters, 0);
  const cancelled = await sentDraft();
  cancelled.mux.paneCurrentCommand = async () => {
    setStatus(cancelled.rec.key, 'cancelled');
    return 'codex';
  };
  assert.equal(await verifyOne(cancelled.rec.key, { resolveMux: () => cancelled.mux }), 'stale');
  assert.equal(cancelled.counts().enters, 0);
});

test('unreadable captures fail visibly instead of retyping a possibly unsubmitted wake', async () => {
  const f = await sentDraft();
  f.mux.capturePane = async () => { throw new Error('capture unavailable'); };
  for (let i = 0; i < 3; i++) await verifyOne(f.rec.key, { resolveMux: () => f.mux });
  assert.equal(f.current().status, 'failed');
  assert.match(f.current().lastError, /submission unconfirmed/);
  assert.deepEqual(f.counts(), { texts: 1, enters: 0 });
});
