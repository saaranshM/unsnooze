// dispatchOne / verifyOne decision logic with fake tmux.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-resumer-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_READY_TIMEOUT_MS = '6000';   // keep the reopen poll short in tests

const { dispatchOne, verifyOne } = await import('../src/resumer.js');
const { upsertSession, readState } = await import('../src/state.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

function seed(overrides = {}) {
  const rec = {
    sessionId: overrides.sessionId ?? `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
    cwd: '/tmp/proj', pane: '%1', tmuxSession: 'unsnooze-test',
    status: 'stopped', limitType: '5h', detectedVia: 'hook',
    detectedAt: Date.now() - 3_600_000, resetAt: Date.now() - 1000,
    resetSource: 'absolute', attempts: 0, lastAttemptAt: null, lastError: null,
    ...overrides,
  };
  const state = upsertSession(rec);
  return Object.values(state.sessions).find(s => s.sessionId === rec.sessionId || s.pane === rec.pane);
}

test('live idle claude pane → message sent', async () => {
  const rec = seed({ pane: '%10' });
  const sent = [];
  const tmux = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'node',
    capturePane: async () => '❯ \n',
    sendText: async (pane, text) => sent.push({ pane, text }),
  };
  const result = await dispatchOne(rec, { tmux });
  assert.equal(result, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].pane, '%10');
  assert.equal(readState().sessions[rec.key].status, 'resuming');
});

test('live but busy pane → deferred, nothing sent', async () => {
  const rec = seed({ pane: '%11' });
  const sent = [];
  const tmux = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '✻ Thinking… (esc to interrupt)',
    sendText: async (...a) => sent.push(a),
  };
  assert.equal(await dispatchOne(rec, { tmux }), 'deferred');
  assert.equal(sent.length, 0);
});

test('dead pane → reopened via new tmux window with --resume <id>', async () => {
  const rec = seed({ pane: '%12', sessionId: '11111111-2222-4333-8444-555555555555' });
  const sent = [];
  let windowCmd = null;
  const tmux = {
    paneAlive: async () => false,
    paneCurrentCommand: async () => null,
    capturePane: async () => '❯ \n',        // new pane immediately ready
    sendText: async (pane, text) => sent.push({ pane, text }),
    newWindow: async (session, cwd, command) => { windowCmd = { session, cwd, command }; return '%99'; },
  };
  const result = await dispatchOne(rec, { tmux });
  assert.equal(result, 'reopened');
  assert.match(windowCmd.command, /--resume 11111111-2222-4333-8444-555555555555/);
  assert.equal(windowCmd.cwd, '/tmp/proj');
  assert.equal(sent[0].pane, '%99');
  assert.equal(readState().sessions[rec.key].pane, '%99');
});

test('pane alive but running a shell → reopen path (never hijack a shell)', async () => {
  const rec = seed({ pane: '%13', sessionId: '22222222-3333-4444-8555-666666666666' });
  let opened = false;
  const tmux = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'zsh',
    capturePane: async () => '❯ \n',
    sendText: async () => {},
    newWindow: async () => { opened = true; return '%98'; },
  };
  assert.equal(await dispatchOne(rec, { tmux }), 'reopened');
  assert.equal(opened, true);
});

test('dead codex pane → reopened via `_run codex resume <id> "msg"`, nothing typed', async () => {
  const rec = seed({ pane: '%20', agent: 'codex', sessionId: '33333333-4444-4555-8666-777777777777' });
  const sent = [];
  let windowCmd = null;
  const tmux = {
    paneAlive: async () => false,
    paneCurrentCommand: async () => null,
    capturePane: async () => '› Ask Codex to do anything\n',
    sendText: async (pane, text) => sent.push({ pane, text }),
    newWindow: async (session, cwd, command) => { windowCmd = { session, cwd, command }; return '%97'; },
  };
  const result = await dispatchOne(rec, { tmux, resumeMessage: "it's time to continue" });
  assert.equal(result, 'reopened');
  assert.match(windowCmd.command, /_run codex resume 33333333-4444-4555-8666-777777777777/);
  assert.match(windowCmd.command, /'it'\\''s time to continue'/);   // shell-quoted argv message
  assert.equal(sent.length, 0);                                     // message travels in argv
});

test('verifyOne: banner back → rescheduled as stopped with attempts+1', async () => {
  const rec = seed({ pane: '%14' });
  const tmuxSend = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '❯ \n',
    sendText: async () => {},
  };
  await dispatchOne(rec, { tmux: tmuxSend });     // → resuming
  const tmuxVerify = {
    capturePane: async () => "⚠ You've hit your 5-hour limit\n· resets 9pm (UTC)\n> ",
  };
  await verifyOne(rec.key, { tmux: tmuxVerify });
  const after1 = readState().sessions[rec.key];
  assert.equal(after1.status, 'stopped');
  assert.equal(after1.attempts, 1);
  assert.ok(after1.resetAt > Date.now());
});

test('verifyOne: clean pane → resumed', async () => {
  const rec = seed({ pane: '%15' });
  const tmuxSend = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '❯ \n',
    sendText: async () => {},
  };
  await dispatchOne(rec, { tmux: tmuxSend });
  await verifyOne(rec.key, { tmux: { capturePane: async () => '⏺ continuing the task…\n' } });
  assert.equal(readState().sessions[rec.key].status, 'resumed');
});
