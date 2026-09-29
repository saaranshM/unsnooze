// A Codex stop completes only on durable evidence in the session's rollout.
// The monitor used to mark any non-claude stop resumed the first tick its
// banner left the 12-line pane scan. In Codex a keypress, a tab switch or an
// overlay does that while the session is still stopped, and the record that
// held the correct reset was dropped for hours.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-codex-progress-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');
process.env.UNSNOOZE_CODEX_DIR = join(DIR, 'codex');

const { createMonitor } = await import('../src/monitor.js');
const { readState } = await import('../src/state.js');
const { getAgent } = await import('../src/agents/index.js');
const { hasCodexProgressAfter } = await import('../src/watchers/codex.js');

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const SESSIONS = join(DIR, 'codex', 'sessions', '2026', '09', '29');
mkdirSync(SESSIONS, { recursive: true });

let nextId = 1;
function rollout(cwd) {
  const id = `01a0dd22-0000-7000-8000-${String(nextId++).padStart(12, '0')}`;
  const path = join(SESSIONS, `rollout-2026-09-29T13-00-00-${id}.jsonl`);
  writeFileSync(path, JSON.stringify({
    timestamp: new Date(Date.now() - 3_600_000).toISOString(),
    type: 'session_meta', payload: { id, cwd, originator: 'codex-tui' },
  }) + '\n');
  return { id, path };
}
const line = (at, type, payload) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload }) + '\n';
const userTurn = at => line(at, 'response_item', { type: 'message', role: 'user', content: [] });
const assistantTurn = at => line(at, 'response_item', { type: 'message', role: 'assistant', content: [] });
const limitError = at => line(at, 'event_msg', {
  type: 'task_complete',
  error: { message: "You've hit your usage limit. Try again at 6:02 PM.", codex_error_info: 'usage_limit_exceeded' },
});

function banner() {
  // Three hours ahead in local time: Codex prints its reset in local time, and
  // a future absolute time corroborates the first tick.
  const d = new Date(Date.now() + 3 * 3_600_000);
  const h = d.getHours() % 12 || 12;
  const time = `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  return `• Ran tests\n\n■ You've hit your usage limit. Upgrade to Pro, or try again at ${time}.\n\n› Ask Codex to do anything\n`;
}
const HIDDEN = '› Ask Codex to do anything\n\n  gpt-5.5 high · ~/project\n';

async function stoppedCodexPane(pane) {
  const cwd = join(DIR, `proj-${pane.slice(1)}`);
  const r = rollout(cwd);
  const script = { text: banner() };
  const mux = {
    sent: [],
    paneAlive: async () => true,
    capturePane: async () => script.text,
    sendText: async (_p, text) => mux.sent.push(text),
    sendKey: async (_p, key) => mux.sent.push(key),
  };
  const agent = { ...getAgent('codex'), latestSessionId: () => r.id };
  const monitor = createMonitor({
    pane, cwd, mux, agent,
    versionSkewed: () => false, spawner: () => { throw new Error('unexpected spawn'); },
  });
  await monitor._tick();
  const rec = Object.values(readState().sessions).find(s => s.pane === pane);
  assert.equal(rec?.status, 'stopped');
  assert.equal(rec.sessionId, r.id);
  return { r, rec, script, mux, monitor, status: () => readState().sessions[rec.key].status };
}

test('a Codex banner hidden from the pane is not a resume', async () => {
  const f = await stoppedCodexPane('%901');
  f.script.text = HIDDEN;
  await f.monitor._tick();
  await f.monitor._tick();
  assert.equal(f.status(), 'stopped', 'the record holding the reset must survive');
  assert.equal(f.mux.sent.length, 0);
});

test('model output in the rollout after the stop completes it', async () => {
  const f = await stoppedCodexPane('%902');
  f.script.text = HIDDEN;
  appendFileSync(f.r.path, userTurn(f.rec.detectedAt + 1000) + assistantTurn(f.rec.detectedAt + 2000));
  await f.monitor._tick();
  assert.equal(f.status(), 'resumed');
});

test('a retry the limit refuses again is not progress', async () => {
  const f = await stoppedCodexPane('%903');
  f.script.text = HIDDEN;
  appendFileSync(f.r.path, userTurn(f.rec.detectedAt + 1000) + limitError(f.rec.detectedAt + 1500));
  await f.monitor._tick();
  assert.equal(f.status(), 'stopped');
});

test('hasCodexProgressAfter: newest evidence governs, older lines never count', () => {
  const cwd = join(DIR, 'proj-unit');
  const root = join(DIR, 'codex', 'sessions');
  const t = Date.now();
  const rec = id => ({ sessionId: id, cwd });

  const before = rollout(cwd);
  appendFileSync(before.path, assistantTurn(t - 5000));
  assert.equal(hasCodexProgressAfter(rec(before.id), t, { sessionsRoot: root }), false, 'output before the stop');

  const stoppedAgain = rollout(cwd);
  appendFileSync(stoppedAgain.path, assistantTurn(t + 1000) + limitError(t + 2000));
  assert.equal(hasCodexProgressAfter(rec(stoppedAgain.id), t, { sessionsRoot: root }), false, 'a newer limit vetoes it');

  const tool = rollout(cwd);
  appendFileSync(tool.path, userTurn(t + 1000) + line(t + 2000, 'response_item', { type: 'custom_tool_call', name: 'apply_patch' }));
  assert.equal(hasCodexProgressAfter(rec(tool.id), t, { sessionsRoot: root }), true, 'a tool call is model output');

  assert.equal(hasCodexProgressAfter({ cwd }, t, { sessionsRoot: root }), false, 'no session id, no evidence');
  assert.equal(hasCodexProgressAfter(rec('ffffffff-0000-7000-8000-000000000000'), t, { sessionsRoot: root }), false);
});

test('a reverted thread is read from its newest rollout file', () => {
  const cwd = join(DIR, 'proj-reverted');
  const root = join(DIR, 'codex', 'sessions');
  const t = Date.now();
  const { id, path } = rollout(cwd);
  const old = new Date(t - 60_000);
  utimesSync(path, old, old);
  const cont = join(SESSIONS, `rollout-2026-09-29T14-00-00-${id}_01a0c026-7b2f-74c3-b576-76743e1da8d7.jsonl`);
  writeFileSync(cont, assistantTurn(t + 1000));
  assert.equal(hasCodexProgressAfter({ sessionId: id, cwd }, t, { sessionsRoot: root }), true);
});

test('a long line straddling the first read window is still read', () => {
  const cwd = join(DIR, 'proj-long');
  const root = join(DIR, 'codex', 'sessions');
  const t = Date.now();
  const { id, path } = rollout(cwd);
  appendFileSync(path, assistantTurn(t + 1000)
    + line(t + 2000, 'response_item', { type: 'function_call_output', output: 'x'.repeat(4096) }));
  assert.equal(hasCodexProgressAfter({ sessionId: id, cwd }, t, { sessionsRoot: root, window: 1024 }), true);
});
