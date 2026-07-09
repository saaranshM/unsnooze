import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// state.js reads UNSNOOZE_STATE_DIR at import time, so set it BEFORE importing.
const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-state-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { updateState, readState, upsertSession, setStatus, activeStopped, dueSessions } =
  await import('../src/state.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

function record(overrides = {}) {
  return {
    sessionId: null, cwd: '/tmp/proj', pane: '%1', tmuxSession: 'unsnooze',
    status: 'stopped', limitType: '5h', detectedVia: 'scrape',
    detectedAt: Date.now(), resetAt: Date.now() + 3_600_000,
    resetSource: 'absolute', attempts: 0, lastAttemptAt: null, lastError: null,
    ...overrides,
  };
}

test('upsert creates keyed record; sessionId key preferred', () => {
  upsertSession(record({ sessionId: 'abc-123', pane: '%2' }));
  const state = readState();
  assert.ok(state.sessions['abc-123']);
  assert.equal(state.sessions['abc-123'].status, 'stopped');
});

test('hook + scrape dedupe on same pane within window; sessionId wins', () => {
  const t = Date.now();
  upsertSession(record({ pane: '%7', detectedAt: t }));               // scrape first, no id
  upsertSession(record({ pane: '%7', detectedAt: t + 5_000, sessionId: 'real-id', detectedVia: 'hook' }));
  const state = readState();
  const matches = Object.values(state.sessions).filter(s => s.pane === '%7');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].sessionId, 'real-id');
});

test('setStatus + activeStopped + dueSessions', () => {
  upsertSession(record({ sessionId: 'due-1', pane: '%3', resetAt: Date.now() - 1000 }));
  upsertSession(record({ sessionId: 'later-1', pane: '%4', resetAt: Date.now() + 9_999_999 }));
  const due = dueSessions();
  assert.ok(due.some(s => s.sessionId === 'due-1'));
  assert.ok(!due.some(s => s.sessionId === 'later-1'));

  setStatus('due-1', 'resumed');
  assert.ok(!activeStopped().some(s => s.sessionId === 'due-1'));
});

test('corrupt state file is quarantined, not fatal', () => {
  writeFileSync(join(DIR, 'state.json'), '{ not json !!!');
  const state = readState();
  assert.deepEqual(state.sessions, {});
  assert.ok(readdirSync(DIR).some(f => f.startsWith('state.json.corrupt.')));
});

test('10 parallel writers do not lose updates', async () => {
  const N = 10;
  const script = `
    process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(DIR)};
    const { updateState } = await import(${JSON.stringify(new URL('../src/state.js', import.meta.url).href)});
    const id = process.argv[2];
    for (let i = 0; i < 5; i++) {
      updateState(s => { s.sessions['w' + id + '-' + i] = { key: 'w' + id + '-' + i, status: 'stopped' }; });
    }
  `;
  await Promise.all(Array.from({ length: N }, (_, i) =>
    execFileAsync(process.execPath, ['--input-type=module', '-e', script, 'writer', String(i)])));
  const state = readState();
  const written = Object.keys(state.sessions).filter(k => k.startsWith('w')).length;
  assert.equal(written, N * 5);
});
