// _remote entrypoint: envelope shape, forced-command re-validation, resume marking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractEnvelope } from '../src/fleet.js';

const KEY = 'aaaa1111-2222-3333-4444-555566667777';

function seedHome() {
  const home = mkdtempSync(join(tmpdir(), 'unsnooze-remote-e2e-'));
  const stateDir = join(home, '.unsnooze');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
    version: 1, sessions: {
      [KEY]: {
        key: KEY, sessionId: KEY, agent: 'claude', cwd: '/tmp/p', status: 'stopped',
        resetAt: Date.now() + 3_600_000, resetSource: 'absolute', mux: 'tmux',
        pane: '%1', muxSession: 'unsnooze', attempts: 0, limitType: '5h', detectedAt: Date.now(),
      },
    },
  }));
  return { home, stateDir };
}

function runRemote(stateDir, args, extraEnv = {}) {
  const env = { ...process.env, UNSNOOZE_STATE_DIR: stateDir, NO_COLOR: '1', ...extraEnv };
  try {
    const out = execFileSync(process.execPath, ['bin/unsnooze.js', '_remote', ...args], { env, encoding: 'utf-8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout ?? '') };
  }
}

test('_remote status: sentinel envelope with handshake + sessions, nothing else on stdout', () => {
  const { home, stateDir } = seedHome();
  const { code, out } = runRemote(stateDir, ['status']);
  assert.equal(code, 0);
  assert.match(out.trim(), /^___UNSNOOZE_BEGIN___.*___UNSNOOZE_END___$/);
  const env2 = extractEnvelope(out);
  assert.equal(env2.schema, 1);
  assert.ok(env2.cli.length > 0);
  assert.ok(env2.host.length > 0);
  assert.deepEqual(env2.caps, ['resume', 'cancel']);
  assert.equal(env2.sessions.length, 1);
  assert.equal(env2.sessions[0].key, KEY);
  rmSync(home, { recursive: true, force: true });
});

test('_remote resume marks the session (resetAt≈now, manual) and reports match', () => {
  const { home, stateDir } = seedHome();
  const { code, out } = runRemote(stateDir, ['resume', KEY.slice(0, 8)]);
  assert.equal(code, 0);
  assert.equal(extractEnvelope(out).result, 'ok');
  const st = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
  assert.ok(st.sessions[KEY].resetAt <= Date.now());
  assert.equal(st.sessions[KEY].manual, true);
  rmSync(home, { recursive: true, force: true });
});

test('_remote: forced-command mode parses SSH_ORIGINAL_COMMAND, rejects junk', () => {
  const { home, stateDir } = seedHome();
  const good = runRemote(stateDir, [], { SSH_ORIGINAL_COMMAND: 'unsnooze _remote status' });
  assert.equal(good.code, 0);
  assert.equal(extractEnvelope(good.out).sessions.length, 1);
  const evil = runRemote(stateDir, [], { SSH_ORIGINAL_COMMAND: 'unsnooze _remote status; rm -rf /' });
  assert.equal(evil.code, 1);
  const evil2 = runRemote(stateDir, [], { SSH_ORIGINAL_COMMAND: 'bash -c evil' });
  assert.equal(evil2.code, 1);
  rmSync(home, { recursive: true, force: true });
});

test('_remote: unknown verb and bad key exit 1 with framed error', () => {
  const { home, stateDir } = seedHome();
  assert.equal(runRemote(stateDir, ['frobnicate']).code, 1);
  assert.equal(runRemote(stateDir, ['resume', 'bad;key']).code, 1);
  assert.equal(runRemote(stateDir, ['resume', 'zzzzzz']).code, 1); // no match
  rmSync(home, { recursive: true, force: true });
});

test('_remote: write-path exception (lock timeout) emits one framed error line', () => {
  const { home, stateDir } = seedHome();
  const lockDir = join(stateDir, 'state.lock');
  // Hold the lock so acquire times out
  mkdirSync(lockDir);

  try {
    const { code, out } = runRemote(stateDir, ['resume', KEY.slice(0, 8)], {
      UNSNOOZE_LOCK_TIMEOUT_MS: '50', // Very short timeout to trigger faster
    });

    assert.equal(code, 1, 'exit code should be 1');

    // Verify stdout is exactly one line matching sentinel frame
    const lines = out.trim().split('\n');
    assert.equal(lines.length, 1, `stdout should be exactly one line, got ${lines.length}: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /^___UNSNOOZE_BEGIN___.*___UNSNOOZE_END___$/, 'should be valid sentinel frame');

    // Verify the result is 'error'
    const env = extractEnvelope(out);
    assert.equal(env.result, 'error', `result should be 'error', got ${env.result}`);
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
