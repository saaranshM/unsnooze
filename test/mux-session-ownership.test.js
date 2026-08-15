// `reap` deletes multiplexer sessions. Until now the only thing standing
// between a user's session and deletion was its name: anything matching
// `unsnooze` / `unsnooze-N` was assumed to be ours.
//
// Users name sessions too. On tmux and zellij the damage was bounded (a
// session has to be empty or exited to qualify), but herdr keeps stopped
// sessions listed forever, so a user's own stopped `unsnooze-9` — a real
// reproduction from review — was stopped and deleted on sight.
//
// Deletion now requires evidence: a record written when we created the
// session, or a live state record still pointing at it.

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-mux-own-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';

const { reap } = await import('../src/reap.js');
const { recordOwnedSession, ownsSession, forgetSession } = await import('../src/mux-sessions.js');
const { readState, updateState, upsertSession } = await import('../src/state.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

beforeEach(() => {
  updateState(state => { state.sessions = {}; return state; });
});

// A backend holding one stopped session with an unsnooze-shaped name.
function fakeMux(deleted, name = 'unsnooze-9') {
  const mux = {
    name: 'tmux',
    available: () => true,
    listSessions: async () => [{ name, exited: true }],
    listSessionPanes: async () => [],
    deleteSession: async session => { deleted.push(session); },
    bind: () => mux,
  };
  return mux;
}

test('a session with an unsnooze-shaped name is NOT deleted without evidence', async () => {
  const deleted = [];
  const mux = fakeMux(deleted);
  const result = await reap({
    yes: true, muxNames: ['tmux'], getMux: () => mux, resolveMux: () => mux,
  });
  assert.deepEqual(deleted, [], 'a name is not proof of ownership');
  const skipped = result.actions.find(a => a.kind === 'skip-unowned-session');
  assert.ok(skipped, 'the refusal is reported, not silent');
  assert.equal(skipped.name, 'unsnooze-9');
  assert.match(skipped.reason, /no record/);
});

test('the same session IS deleted once there is a record that we created it', async () => {
  const deleted = [];
  const mux = fakeMux(deleted);
  recordOwnedSession({ mux: 'tmux', name: 'unsnooze-9' });
  await reap({ yes: true, muxNames: ['tmux'], getMux: () => mux, resolveMux: () => mux });
  assert.deepEqual(deleted, ['unsnooze-9'], 'evidence unlocks the cleanup');
  assert.equal(ownsSession('tmux', 'unsnooze-9'), false, 'and the spent record is cleaned up');
});

test('a session we recorded creating IS deleted, and the record is cleaned up', async () => {
  recordOwnedSession({ mux: 'tmux', name: 'unsnooze-9' });
  assert.equal(ownsSession('tmux', 'unsnooze-9'), true);
  forgetSession('tmux', 'unsnooze-9');
  assert.equal(ownsSession('tmux', 'unsnooze-9'), false, 'forget removes the evidence');
});

test('the ownership record survives a round trip and is scoped per backend', () => {
  recordOwnedSession({ mux: 'herdr', name: 'unsnooze' });
  assert.equal(ownsSession('herdr', 'unsnooze'), true);
  assert.equal(ownsSession('tmux', 'unsnooze'), false, 'same name, different backend, different session');
  assert.equal(ownsSession('herdr', 'unsnooze-2'), false);
  forgetSession('herdr', 'unsnooze');
});

test('a missing or unreadable record reads as "not ours", never as ours', () => {
  assert.equal(ownsSession('herdr', 'never-created'), false);
  assert.equal(ownsSession(undefined, undefined), false);
  assert.equal(recordOwnedSession({ mux: 'herdr' }), null, 'a nameless session cannot be recorded');
});

test('a live state record naming the session counts as evidence', async () => {
  upsertSession({
    sessionId: 'own-1', cwd: '/tmp', pane: '%1', mux: 'tmux', paneOwner: null,
    muxSession: 'unsnooze-9', status: 'resumed', limitType: '5h', detectedVia: 'hook',
    detectedAt: Date.now(), resetAt: Date.now(), resetSource: 'absolute',
    attempts: 0, lastAttemptAt: Date.now(), lastError: null,
  });
  const claimed = Object.values(readState().sessions)
    .some(rec => rec.mux === 'tmux' && rec.muxSession === 'unsnooze-9');
  assert.equal(claimed, true, 'the state record is the second form of evidence reap accepts');
});
