// `unsnooze message <id|--all> <text...>` — per-session wake messages.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-message-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';

const { cmdMessage, cmdStatus, cmdResumeNow } = await import('../src/cli.js');
const { upsertSession, readState } = await import('../src/state.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

function seed(pane, extra = {}) {
  const state = upsertSession({
    sessionId: extra.sessionId ?? null, cwd: '/tmp/proj', pane,
    agent: 'claude', tmuxSession: 'unsnooze-test', status: 'stopped',
    limitType: '5h', detectedVia: 'scrape', detectedAt: Date.now() - 60_000,
    resetAt: Date.now() + 3_600_000, resetSource: 'absolute',
    attempts: 0, lastAttemptAt: null, lastError: null,
    ...extra,
  });
  return Object.values(state.sessions).find(s => s.pane === pane);
}

test('sets a custom message by id prefix', () => {
  const rec = seed('%40', { sessionId: 'aaaa1111-2222-4333-8444-555555555555' });
  const code = cmdMessage(['aaaa1111', 'finish', 'the', 'tests', 'then', 'commit']);
  assert.equal(code, 0);
  assert.equal(readState().sessions[rec.key].resumeMessage, 'finish the tests then commit');
});

test('sets for all non-terminal sessions with --all', () => {
  seed('%41');
  seed('%42', { status: 'resuming' });
  seed('%43', { status: 'cancelled' });
  const code = cmdMessage(['--all', 'wrap it up']);
  assert.equal(code, 0);
  const s = readState().sessions;
  const byPane = pane => Object.values(s).find(r => r.pane === pane);
  assert.equal(byPane('%41').resumeMessage, 'wrap it up');
  assert.equal(byPane('%42').resumeMessage, 'wrap it up');
  assert.equal(byPane('%43').resumeMessage, undefined, 'terminal sessions are untouched');
});

test('--clear reverts to the global default', () => {
  const rec = seed('%44', { sessionId: 'bbbb2222-3333-4444-8555-666666666666' });
  cmdMessage(['bbbb2222', 'custom']);
  assert.equal(readState().sessions[rec.key].resumeMessage, 'custom');
  const code = cmdMessage(['bbbb2222', '--clear']);
  assert.equal(code, 0);
  assert.equal(readState().sessions[rec.key].resumeMessage, undefined);
});

test('no match → exit 1; missing text → exit 2', () => {
  assert.equal(cmdMessage(['zzzzzzzz', 'hello']), 1);
  assert.equal(cmdMessage(['--all']), 2);
});

test('status output marks sessions with a custom message', () => {
  seed('%45', { sessionId: 'cccc3333-4444-4555-8666-777777777777' });
  cmdMessage(['cccc3333', 'run the deploy checklist']);
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { cmdStatus(); } finally { console.log = orig; }
  const out = lines.join('\n');
  assert.match(out, /msg: "run the deploy checklist"/);
});

test('held sessions: status shows the marker, resume-now clears the hold', () => {
  const rec = seed('%46', { workspaceHold: true, holdReason: 'HEAD aaaaaaa → bbbbbbb', resetAt: Date.now() - 1000 });
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    cmdStatus();
    assert.match(lines.join('\n'), /workspace changed .*resume-now/i);
    cmdResumeNow(rec.key);
  } finally { console.log = orig; }
  const after1 = readState().sessions[rec.key];
  assert.equal(after1.workspaceHold, undefined, 'resume-now clears the hold');
  assert.equal(after1.manual, true);
});
