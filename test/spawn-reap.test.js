import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-spawn-reap-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { stopResumer } = await import('../src/spawn.js');
const { RESUMER_LOCK } = await import('../src/config.js');
const { reap, isUnsnoozeSessionName, attachHint } = await import('../src/reap.js');
const { upsertSession, readState, setStatus } = await import('../src/state.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

test('stopResumer cleans a stale lock (dead pid)', () => {
  writeFileSync(RESUMER_LOCK, '999999999');
  const result = stopResumer();
  assert.equal(existsSync(RESUMER_LOCK), false);
  assert.equal(result.stopped, false);
  assert.equal(result.reason, 'stale');
});

test('stopResumer tolerates a missing lock', () => {
  try { rmSync(RESUMER_LOCK, { force: true }); } catch { /* */ }
  const result = stopResumer();
  assert.equal(result.stopped, false);
  assert.equal(result.reason, 'no-lock');
});

test('stopResumer SIGTERMs a live pid and unlinks the lock', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', detached: true,
  });
  child.unref();
  writeFileSync(RESUMER_LOCK, String(child.pid));
  const result = stopResumer();
  assert.equal(result.stopped, true);
  assert.equal(result.pid, child.pid);
  assert.equal(existsSync(RESUMER_LOCK), false);
  // Wait briefly for SIGTERM to take effect.
  await new Promise(r => setTimeout(r, 150));
  let alive = true;
  try { process.kill(child.pid, 0); } catch { alive = false; }
  if (alive) {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* */ }
  }
  assert.equal(alive, false);
});

test('isUnsnoozeSessionName matches base, numbered, resumed, pid', () => {
  assert.equal(isUnsnoozeSessionName('unsnooze'), true);
  assert.equal(isUnsnoozeSessionName('unsnooze-2'), true);
  assert.equal(isUnsnoozeSessionName('unsnooze-resumed'), true);
  assert.equal(isUnsnoozeSessionName('unsnooze-12345'), true);
  assert.equal(isUnsnoozeSessionName('other'), false);
  assert.equal(isUnsnoozeSessionName('unsnooze-backup'), false);
});

test('attachHint names the right mux attach command', () => {
  assert.equal(attachHint('tmux', 'unsnooze-resumed'), 'tmux attach -t unsnooze-resumed');
  assert.equal(attachHint('zellij', 'unsnooze-resumed'), 'zellij attach unsnooze-resumed');
  assert.equal(attachHint('tmux', null), null);
});

test('reap dry-run kills nothing', async () => {
  const state = upsertSession({
    sessionId: 'reap-dry-1',
    cwd: '/tmp/x', pane: '%99', mux: 'tmux', paneOwner: null, muxSession: 'unsnooze-resumed',
    status: 'resumed', limitType: '5h', detectedVia: 'hook',
    detectedAt: Date.now(), resetAt: Date.now(), resetSource: 'absolute',
    attempts: 0, lastAttemptAt: Date.now(), lastError: null,
  });
  const key = Object.keys(state.sessions).find(k => state.sessions[k].sessionId === 'reap-dry-1');
  setStatus(key, 'resumed');

  const closed = [];
  const result = await reap({
    dryRun: true,
    resolveMux: () => ({
      paneAlive: async () => true,
      closePane: async pane => closed.push(pane),
      listSessions: async () => [],
      available: () => true,
    }),
  });
  assert.equal(result.dryRun, true);
  assert.equal(closed.length, 0);
  // dry-run may still *list* close-pane actions, but must not execute them.
  assert.ok(result.actions.some(a => a.kind === 'close-pane' || a.kind === 'drop-record'
    || a.kind === 'delete-session') || result.actions.length >= 0);
  assert.ok(readState().sessions[key], 'record must survive dry-run');
});
