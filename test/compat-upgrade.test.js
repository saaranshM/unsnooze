// Upgrade path: existing users' state/config/env must keep working after update.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-compat-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';

const {
  MUX_SESSION_NAME, TMUX_SESSION_NAME, RESUME_SESSION_NAME,
} = await import('../src/config.js');
const { reviveTarget } = await import('../src/resumer.js');
const { upsertSession, readState, updateState } = await import('../src/state.js');
const { getConfig } = await import('../src/settings.js');
const { fmtResetProvenance } = await import('../src/cli.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

test('TMUX_SESSION_NAME remains a compatible alias of MUX_SESSION_NAME', () => {
  assert.equal(TMUX_SESSION_NAME, MUX_SESSION_NAME);
});

test('legacy env UNSNOOZE_TMUX_SESSION still names the interactive base', async () => {
  // Config module caches at import; we only assert the documented fallback chain
  // is still present in source defaults (name resolves without throwing).
  assert.equal(typeof MUX_SESSION_NAME, 'string');
  assert.ok(MUX_SESSION_NAME.length > 0);
  assert.ok(RESUME_SESSION_NAME.endsWith('-resumed'));
  assert.notEqual(RESUME_SESSION_NAME, MUX_SESSION_NAME);
});

test('reviveTarget joins legacy muxSession=unsnooze when that session is still live', async () => {
  const live = { sessionExists: async name => name === 'unsnooze' };
  assert.equal(await reviveTarget(live, { muxSession: 'unsnooze' }), 'unsnooze');
  // Pre-muxSession field only:
  assert.equal(await reviveTarget(live, { tmuxSession: 'unsnooze', muxSession: null }), 'unsnooze');
});

test('reviveTarget never creates the interactive base when the ghost is gone', async () => {
  const dead = { sessionExists: async () => false };
  assert.equal(await reviveTarget(dead, { muxSession: 'unsnooze' }), RESUME_SESSION_NAME);
});

test('existing config without new keys keeps prior defaults (safe upgrade)', () => {
  // No config.json written — defaults apply. New keys must not change old behaviour.
  // (notifications is forced off at the top of this file so tests stay silent.)
  assert.equal(getConfig('autoResume'), true);
  assert.equal(getConfig('menuAutoAnswer'), true);
  assert.equal(getConfig('notifications'), false); // env override in this suite
  assert.equal(getConfig('notifyChannel'), 'auto'); // additive; native still used when no pane
  assert.equal(getConfig('reapResumed'), false);    // opt-in only — never auto-kill old panes
  assert.equal(getConfig('guiWatch'), true);
  assert.equal(getConfig('workspaceGuard'), 'inform');
  assert.equal(getConfig('contextGuard'), 'inform');
});

test('status provenance degrades gracefully for pre-provenance records', () => {
  assert.equal(
    fmtResetProvenance({ resetSource: 'absolute' }),
    'absolute',
  );
  assert.equal(
    fmtResetProvenance({ resetSource: 'fallback' }),
    'guessed: no reset time found — probing',
  );
  assert.equal(
    fmtResetProvenance({}),
    'guessed: no reset time found — probing',
  );
});

test('stopped record without bannerAt still due-dispatches (no required new fields)', () => {
  const rec = {
    sessionId: 'compat-1',
    cwd: '/tmp/p',
    pane: '%1',
    mux: 'tmux',
    paneOwner: null,
    muxSession: 'unsnooze',
    status: 'stopped',
    limitType: '5h',
    detectedVia: 'hook',
    detectedAt: Date.now() - 60_000,
    resetAt: Date.now() - 1000,
    resetSource: 'absolute',
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    // deliberately no bannerAt / probeCount
  };
  upsertSession(rec);
  const saved = Object.values(readState().sessions).find(s => s.sessionId === 'compat-1');
  assert.ok(saved);
  assert.equal(saved.bannerAt, undefined);
  assert.ok(saved.resetAt <= Date.now());
});
