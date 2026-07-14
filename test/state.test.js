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
    sessionId: null, cwd: '/tmp/proj', pane: '%1', mux: 'tmux', paneOwner: null,
    muxSession: 'unsnooze',
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

test('readState migrates live-pane and pane-less legacy records to tmux', () => {
  const before = readState().sessions;
  updateState(state => {
    state.sessions = {
      live: { ...record({ sessionId: 'live', pane: '%44' }), mux: undefined, muxSession: undefined, tmuxSession: 'legacy-live' },
      paneless: { ...record({ sessionId: 'paneless', pane: null }), mux: undefined, muxSession: undefined, tmuxSession: 'legacy-paneless' },
    };
  });
  const state = readState();
  assert.equal(state.sessions.live.mux, 'tmux');
  assert.equal(state.sessions.live.muxSession, 'legacy-live');
  assert.equal(state.sessions.paneless.mux, 'tmux');
  assert.equal(state.sessions.paneless.muxSession, 'legacy-paneless');
  updateState(current => { current.sessions = before; });
});

test('legacy tmux records: bogus paneOwner session name is cleared to null', () => {
  // Pre-ownership-fix newWindow stored sessionName as paneOwner for tmux,
  // which made leaseMatches permanently fail. Upgrade must heal existing state.
  updateState(state => {
    state.sessions.legacy_owner = {
      ...record({ sessionId: 'legacy-owner', pane: '%90' }),
      mux: 'tmux',
      paneOwner: 'unsnooze',   // wrong — tmux panes are server-global
      muxSession: 'unsnooze',
    };
  });
  const found = Object.values(readState().sessions).find(s => s.sessionId === 'legacy-owner');
  assert.ok(found);
  assert.equal(found.paneOwner, null);
  assert.equal(found.muxSession, 'unsnooze'); // session name kept for revive join
  // zellij owners must NOT be cleared — ids are per-session there.
  updateState(state => {
    state.sessions.zj = {
      ...record({ sessionId: 'zj-keep', pane: '3' }),
      mux: 'zellij',
      paneOwner: 'main',
      muxSession: 'main',
    };
  });
  const zj = Object.values(readState().sessions).find(s => s.sessionId === 'zj-keep');
  assert.equal(zj.paneOwner, 'main');
});

test('legacy fallback now+5h waits are pulled into the probe window', async () => {
  const { PROBE_INTERVAL_MS, PROBE_MAX_MS } = await import('../src/config.js');
  const far = Date.now() + 5 * 3_600_000 + 60_000; // classic FALLBACK_RESET + margin
  updateState(state => {
    state.sessions.old_fb = {
      ...record({ sessionId: 'old-fb', pane: '%91' }),
      resetSource: 'fallback',
      resetAt: far,
    };
  });
  const rec = Object.values(readState().sessions).find(s => s.sessionId === 'old-fb');
  assert.ok(rec.resetAt <= Date.now() + PROBE_INTERVAL_MS + 5_000);
  assert.ok(rec.resetAt >= Date.now() - 1_000);
  // Fresh probe schedules (within the ladder) must not be pulled earlier.
  const probeAt = Date.now() + PROBE_MAX_MS;
  updateState(state => {
    state.sessions.fresh_fb = {
      ...record({ sessionId: 'fresh-fb', pane: '%92' }),
      resetSource: 'fallback',
      resetAt: probeAt,
    };
  });
  const fresh = Object.values(readState().sessions).find(s => s.sessionId === 'fresh-fb');
  assert.ok(Math.abs(fresh.resetAt - probeAt) < 2_000);
  // Absolute far-future waits are intentional — leave them alone.
  const absAt = Date.now() + 5 * 3_600_000;
  updateState(state => {
    state.sessions.abs_far = {
      ...record({ sessionId: 'abs-far', pane: '%93' }),
      resetSource: 'absolute',
      resetAt: absAt,
    };
  });
  const abs = Object.values(readState().sessions).find(s => s.sessionId === 'abs-far');
  assert.ok(Math.abs(abs.resetAt - absAt) < 2_000);
});

test('pane dedupe includes mux and owner instead of colliding on raw pane id', () => {
  const t = Date.now();
  upsertSession(record({ pane: '1', mux: 'zellij', paneOwner: 'alpha', detectedAt: t }));
  upsertSession(record({ pane: '1', mux: 'zellij', paneOwner: 'beta', detectedAt: t + 1 }));
  const matches = Object.values(readState().sessions).filter(s => s.pane === '1');
  assert.equal(matches.length, 2);
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

test('transcript record with sessionId merges into a pane record lacking one (same agent+cwd)', () => {
  const t = Date.now();
  upsertSession(record({ pane: '%12', agent: 'codex', cwd: '/tmp/proj-c', detectedAt: t }));
  // Watcher record: no pane key at all — a GUI/transcript detection.
  upsertSession({
    sessionId: 'roll-1', agent: 'codex', cwd: '/tmp/proj-c', mux: 'tmux', paneOwner: null, muxSession: 'unsnooze',
    status: 'stopped', limitType: '5h', detectedVia: 'transcript',
    detectedAt: t + 4_000, resetAt: t + 3_600_000, resetSource: 'absolute',
    attempts: 0, lastAttemptAt: null, lastError: null,
  });
  const matches = Object.values(readState().sessions)
    .filter(s => s.cwd === '/tmp/proj-c' && s.agent === 'codex');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].sessionId, 'roll-1');
  assert.equal(matches[0].pane, '%12');   // the live pane must survive the merge

  // A later tick re-detecting the same sessionId must still merge, even though
  // the record's key is the original pane key.
  upsertSession({
    sessionId: 'roll-1', agent: 'codex', cwd: '/tmp/proj-c', mux: 'tmux', paneOwner: null, muxSession: 'unsnooze',
    status: 'stopped', limitType: '5h', detectedVia: 'transcript',
    detectedAt: t + 8_000, resetAt: t + 3_600_000, resetSource: 'absolute',
    attempts: 0, lastAttemptAt: null, lastError: null,
  });
  const again = Object.values(readState().sessions)
    .filter(s => s.cwd === '/tmp/proj-c' && s.agent === 'codex');
  assert.equal(again.length, 1);
});

test('mid-resume detection dedupes into the resuming record and keeps its status', () => {
  // Regression: while the resumer types into a pane, a monitor scrape can
  // still see the banner for a few hundred ms. That must NOT create a second
  // record (double-resume), and must not clobber 'resuming' — the post-resume
  // verify pass owns that outcome.
  const t = Date.now();
  const state1 = upsertSession(record({ pane: '%80', cwd: '/tmp/proj-race', detectedAt: t }));
  const key = Object.values(state1.sessions).find(s => s.pane === '%80').key;
  setStatus(key, 'resuming', { lastAttemptAt: t });
  upsertSession(record({ pane: '%80', cwd: '/tmp/proj-race', detectedAt: t + 2_000 }));   // scrape during the race window
  const matches = Object.values(readState().sessions).filter(s => s.pane === '%80');
  assert.equal(matches.length, 1, 'must not create a duplicate record');
  assert.equal(matches[0].status, 'resuming', 'verify pass owns the resuming outcome');
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

test('upsert fingerprints git workspaces; dedupe merge keeps the original', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync } = await import('node:fs');
  const repo = join(DIR, 'ws-repo');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  mkdirSync(repo, { recursive: true });
  g('init', '-q');
  writeFileSync(join(repo, 'f.txt'), 'x\n');
  g('add', '.');
  g('commit', '-qm', 'init');

  const t = Date.now();
  const s1 = upsertSession(record({ pane: '%90', cwd: repo, detectedAt: t }));
  const rec1 = Object.values(s1.sessions).find(r => r.pane === '%90');
  assert.ok(rec1.workspace && rec1.workspace.head, 'fingerprint captured at stop time');

  // repo moves on; a duplicate detection within the window must keep the
  // ORIGINAL stop-time fingerprint (that is the baseline for the guard)
  writeFileSync(join(repo, 'f.txt'), 'y\n');
  g('commit', '-aqm', 'moved');
  const s2 = upsertSession(record({ pane: '%90', cwd: repo, detectedAt: t + 2000 }));
  const rec2 = Object.values(s2.sessions).find(r => r.pane === '%90');
  assert.equal(rec2.workspace.head, rec1.workspace.head, 'merge must not refresh the baseline');

  // non-git cwd → no fingerprint, no crash
  const s3 = upsertSession(record({ pane: '%91', cwd: '/tmp', detectedAt: t }));
  const rec3 = Object.values(s3.sessions).find(r => r.pane === '%91');
  assert.equal(rec3.workspace, null);
});
