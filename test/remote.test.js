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

// queue-add's success path calls queueAdd(), which by default spawns a
// detached resumer daemon (spawnResumerIfNeeded) — the right production
// behavior for a remote host, but fatal for a test: this suite forks real
// subprocesses, and an unref'd detached grandchild would keep running against
// a state dir this test is about to rmSync out from under it, completely
// decoupled from the test's own lifecycle. UNSNOOZE_REMOTE_TEST_NO_SPAWN is
// remote.js's own scoped test seam for exactly this (see src/remote.js) —
// every queue-add call in this file must carry it.
const NO_SPAWN = { UNSNOOZE_REMOTE_TEST_NO_SPAWN: '1' };

function payloadFor(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
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
  assert.deepEqual(env2.caps, ['resume', 'cancel', 'queue']);
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

// ---------------------------------------------------------------------------
// Task 5: queue-add / queue-list / queue-remove / queue-clear
// ---------------------------------------------------------------------------

test('_remote queue-add: happy path — ok + entry persisted with createdBy remote', () => {
  const { home, stateDir } = seedHome();
  const payload = payloadFor({ cwd: home, agent: 'claude', prompt: 'do the remote thing', mode: 'now' });
  const { code, out } = runRemote(stateDir, ['queue-add', payload], NO_SPAWN);
  assert.equal(code, 0);
  const env = extractEnvelope(out);
  assert.equal(env.result, 'ok');
  assert.match(env.id, /^p-[0-9a-f]{8}$/);

  const st = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
  assert.equal(st.promptQueue.length, 1);
  const entry = st.promptQueue[0];
  assert.equal(entry.id, env.id);
  assert.equal(entry.createdBy, 'remote');
  assert.equal(entry.cwd, home);
  assert.equal(entry.agent, 'claude');
  assert.equal(entry.prompt, 'do the remote thing');
  assert.equal(entry.mode, 'now');
  assert.equal(entry.status, 'pending');
  rmSync(home, { recursive: true, force: true });
});

test('_remote queue-add: works through the SSH_ORIGINAL_COMMAND forced-command path too, and rejects an appended injection attempt', () => {
  const { home, stateDir } = seedHome();
  const payload = payloadFor({ cwd: home, agent: 'claude', prompt: 'via forced command', mode: 'now' });

  const good = runRemote(stateDir, [], { SSH_ORIGINAL_COMMAND: `unsnooze _remote queue-add ${payload}`, ...NO_SPAWN });
  assert.equal(good.code, 0);
  assert.equal(extractEnvelope(good.out).result, 'ok');

  // A trailing shell-injection-shaped suffix makes SSH_ORIGINAL_COMMAND split
  // into more than the 2-token (verb + arg) shape resolveRequest allows —
  // must be rejected outright, never executed or partially honored.
  const evil = runRemote(stateDir, [], { SSH_ORIGINAL_COMMAND: `unsnooze _remote queue-add ${payload}; rm -rf /`, ...NO_SPAWN });
  assert.equal(evil.code, 1);
  assert.equal(extractEnvelope(evil.out).result, 'bad-request');

  const st = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
  assert.equal(st.promptQueue.length, 1, 'only the good request was honored');
  rmSync(home, { recursive: true, force: true });
});

test('_remote queue-add: mode "at" carries atMs through', () => {
  const { home, stateDir } = seedHome();
  const atMs = Date.now() + 3_600_000;
  const payload = payloadFor({ cwd: home, agent: 'claude', prompt: 'later', mode: 'at', atMs });
  const { code, out } = runRemote(stateDir, ['queue-add', payload], NO_SPAWN);
  assert.equal(code, 0);
  const env = extractEnvelope(out);
  assert.equal(env.result, 'ok');
  const st = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
  assert.equal(st.promptQueue[0].mode, 'at');
  assert.equal(st.promptQueue[0].atMs, atMs);
  rmSync(home, { recursive: true, force: true });
});

test('_remote queue-add: hostile/malformed payloads all bad-request, one framed line, no state change', () => {
  const { home, stateDir } = seedHome();
  const cases = {
    'oversize (>8192 chars)': 'a'.repeat(8193),
    'non-base64url charset': `${'a'.repeat(20)}+/=`,
    'valid b64url of invalid JSON': Buffer.from('not-json{', 'utf8').toString('base64url'),
    'relative cwd': payloadFor({ cwd: 'relative/path', agent: 'claude', prompt: 'hi', mode: 'now' }),
    'non-existent cwd': payloadFor({ cwd: '/definitely/does/not/exist/xyz-987', agent: 'claude', prompt: 'hi', mode: 'now' }),
    'unknown agent': payloadFor({ cwd: home, agent: 'not-a-real-agent', prompt: 'hi', mode: 'now' }),
    'empty prompt after sanitize (pure ANSI)': payloadFor({ cwd: home, agent: 'claude', prompt: '\x1b[31m\x1b[0m', mode: 'now' }),
    'bad mode': payloadFor({ cwd: home, agent: 'claude', prompt: 'hi', mode: 'yesterday' }),
    'mode "at" with non-finite atMs': payloadFor({ cwd: home, agent: 'claude', prompt: 'hi', mode: 'at', atMs: 'soon' }),
  };

  for (const [label, payload] of Object.entries(cases)) {
    const { code, out } = runRemote(stateDir, ['queue-add', payload], NO_SPAWN);
    assert.equal(code, 1, `${label}: expected exit 1`);
    const lines = out.trim().split('\n');
    assert.equal(lines.length, 1, `${label}: exactly one framed line`);
    assert.match(lines[0], /^___UNSNOOZE_BEGIN___.*___UNSNOOZE_END___$/, `${label}: valid sentinel frame`);
    assert.equal(extractEnvelope(out).result, 'bad-request', `${label}: result must be bad-request`);
  }

  const st = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
  assert.equal((st.promptQueue || []).length, 0, 'no hostile payload left an entry behind');
  rmSync(home, { recursive: true, force: true });
});

test('_remote queue-add: __proto__/constructor keys in the payload JSON are inert (fresh-literal reconstruction)', () => {
  const { home, stateDir } = seedHome();
  // Built as a raw JSON string (not a JS object literal) so "__proto__"
  // round-trips as a literal JSON key rather than being consumed by object-
  // literal syntax as an actual prototype assignment before it ever reaches
  // the wire — this is what a real hostile client would send.
  const rawJson = `{"cwd":${JSON.stringify(home)},"agent":"claude","prompt":"hi","mode":"now",`
    + `"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`;
  const evil = Buffer.from(rawJson, 'utf8').toString('base64url');

  const { code, out } = runRemote(stateDir, ['queue-add', evil], NO_SPAWN);
  assert.equal(code, 0);
  const env = extractEnvelope(out);
  assert.equal(env.result, 'ok');
  assert.equal(({}).polluted, undefined, 'Object.prototype must never be polluted');

  const st = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
  const entry = st.promptQueue.find(e => e.id === env.id);
  assert.ok(entry, 'entry persisted');
  assert.equal('polluted' in entry, false, 'no smuggled field reached the stored entry');
  assert.equal(entry.cwd, home);
  assert.equal(entry.agent, 'claude');
  rmSync(home, { recursive: true, force: true });
});

test('_remote: remoteQueue=false disables all four queue verbs (still a valid framed envelope)', () => {
  const { home, stateDir } = seedHome();
  const payload = payloadFor({ cwd: home, agent: 'claude', prompt: 'hi', mode: 'now' });
  const disabledEnv = { UNSNOOZE_REMOTE_QUEUE: '0', ...NO_SPAWN };
  for (const args of [['queue-add', payload], ['queue-list'], ['queue-remove', 'p-deadbeef'], ['queue-clear']]) {
    const { code, out } = runRemote(stateDir, args, disabledEnv);
    assert.equal(code, 1, `${args[0]}: disabled verbs exit 1`);
    const env = extractEnvelope(out);
    assert.equal(env.result, 'disabled', `${args[0]}: result must be 'disabled'`);
    assert.equal(env.schema, 1, `${args[0]}: still a valid framed envelope`);
  }
  const st = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
  assert.equal((st.promptQueue || []).length, 0);
  rmSync(home, { recursive: true, force: true });
});

test('_remote queue-remove: unknown id -> not-found; bad id shape -> bad-request', () => {
  const { home, stateDir } = seedHome();
  const notFound = runRemote(stateDir, ['queue-remove', 'p-deadbeef']);
  assert.equal(notFound.code, 1);
  assert.equal(extractEnvelope(notFound.out).result, 'not-found');

  const badShape = runRemote(stateDir, ['queue-remove', 'not-a-valid-id']);
  assert.equal(badShape.code, 1);
  assert.equal(extractEnvelope(badShape.out).result, 'bad-request');
  rmSync(home, { recursive: true, force: true });
});

test('_remote queue-remove: removes a pending entry (ok)', () => {
  const { home, stateDir } = seedHome();
  const payload = payloadFor({ cwd: home, agent: 'claude', prompt: 'hi', mode: 'now' });
  const added = runRemote(stateDir, ['queue-add', payload], NO_SPAWN);
  const id = extractEnvelope(added.out).id;

  const { code, out } = runRemote(stateDir, ['queue-remove', id]);
  assert.equal(code, 0);
  assert.equal(extractEnvelope(out).result, 'ok');
  const st = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
  assert.equal(st.promptQueue.find(e => e.id === id).status, 'cancelled');
  rmSync(home, { recursive: true, force: true });
});

test('_remote queue-clear: cancels every pending entry and reports the count', () => {
  const { home, stateDir } = seedHome();
  runRemote(stateDir, ['queue-add', payloadFor({ cwd: home, agent: 'claude', prompt: 'one', mode: 'now' })], NO_SPAWN);
  runRemote(stateDir, ['queue-add', payloadFor({ cwd: home, agent: 'claude', prompt: 'two', mode: 'now' })], NO_SPAWN);

  const { code, out } = runRemote(stateDir, ['queue-clear']);
  assert.equal(code, 0);
  const env = extractEnvelope(out);
  assert.equal(env.result, 'ok');
  assert.equal(env.cleared, 2);
  rmSync(home, { recursive: true, force: true });
});

test('_remote queue-list: returns the queue subset (id/agent/cwd/status/mode/promptPreview)', () => {
  const { home, stateDir } = seedHome();
  runRemote(stateDir, ['queue-add', payloadFor({ cwd: home, agent: 'claude', prompt: 'list me', mode: 'now' })], NO_SPAWN);

  const { code, out } = runRemote(stateDir, ['queue-list']);
  assert.equal(code, 0);
  const env = extractEnvelope(out);
  assert.equal(env.result, 'ok');
  assert.equal(env.queue.length, 1);
  assert.equal(env.queue[0].agent, 'claude');
  assert.equal(env.queue[0].status, 'pending');
  assert.equal(env.queue[0].promptPreview, 'list me');
  rmSync(home, { recursive: true, force: true });
});

test('_remote status: queue block is sanitized, promptPreview truncated to 80, C1/ESC bytes never survive', () => {
  const { home, stateDir } = seedHome();
  // sanitizePrompt (prompt-queue.js) already strips ANSI/C0/C1 at queueAdd
  // time — this asserts the stored form is clean and stays clean through the
  // status envelope's emitter subset, not that the emitter does its own
  // stripping (it doesn't need to; see src/remote.js's queueEnvelopeEntries).
  const dirty = `\x1b[31m${'x'.repeat(200)}\x9b31mY`;
  const payload = payloadFor({ cwd: home, agent: 'claude', prompt: dirty, mode: 'now' });
  const added = runRemote(stateDir, ['queue-add', payload], NO_SPAWN);
  assert.equal(added.code, 0);

  const storedState = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
  const storedPrompt = storedState.promptQueue[0].prompt;
  assert.doesNotMatch(storedPrompt, /[\x1b\x9b]/, 'stored prompt is already clean at rest');

  const { code, out } = runRemote(stateDir, ['status']);
  assert.equal(code, 0);
  const env = extractEnvelope(out);
  assert.ok(Array.isArray(env.queue));
  assert.equal(env.queue.length, 1);
  const q = env.queue[0];
  assert.equal(q.status, 'pending');
  assert.equal(q.agent, 'claude');
  assert.ok(q.promptPreview.length <= 80, 'promptPreview capped to 80 chars');
  assert.doesNotMatch(q.promptPreview, /[\x1b\x9b]/, 'no C1/ESC byte in the envelope');
  assert.ok(q.promptPreview.startsWith('x'.repeat(20)), 'plain text survives sanitization');
  rmSync(home, { recursive: true, force: true });
});

test('_remote status: queue array is capped at 50 entries', () => {
  // Seeded directly onto disk (bypassing queueAdd, which has its own
  // 50-pending-entry cap at the prompt-queue.js layer) so this specifically
  // exercises remote.js's own QUEUE_STATUS_CAP slice on the emitter side,
  // independent of prompt-queue.js's business-logic cap.
  const { home, stateDir } = seedHome();
  const promptQueue = Array.from({ length: 55 }, (_, i) => ({
    id: `p-${i.toString(16).padStart(8, '0')}`, cwd: home, agent: 'claude', prompt: `p${i}`,
    mode: 'now', atMs: null, notBefore: 0, createdAt: Date.now(), createdBy: 'remote',
    status: 'pending', attempts: 0, lastError: null, deliveredAt: null, sentAt: null,
    pane: null, muxSession: null, leaseId: null,
  }));
  const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8'));
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ ...state, promptQueue }));

  const { code, out } = runRemote(stateDir, ['status']);
  assert.equal(code, 0);
  const env = extractEnvelope(out);
  assert.equal(env.queue.length, 50);
  rmSync(home, { recursive: true, force: true });
});
