// Password source resolvers: env/command/keychain/prompt, dispatch, AuthError.
// Every OS branch is exercised via injected `platform` — no platform-skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveEnv, resolveCommand, resolveKeychain, resolvePrompt, resolveSecret, AuthError,
} from '../src/askpass.js';

test('resolveEnv: reads the var; missing throws AuthError', () => {
  assert.equal(resolveEnv({ env: 'PW' }, { env: { PW: 's3cret' } }), 's3cret');
  assert.throws(() => resolveEnv({ env: 'PW' }, { env: {} }), AuthError);
});

test('resolveEnv: thrown error carries needsAuth', () => {
  try {
    resolveEnv({ env: 'PW' }, { env: {} });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof AuthError);
    assert.equal(e.needsAuth, true);
  }
});

// command is the user's OWN configured, trusted string (git-credential-helper
// style, like `credential.helper = !cmd`) — shell-executed for flexibility,
// since there is no untrusted input crossing this boundary.
test('resolveCommand: shell-executes entry.cmd, trims one trailing newline', () => {
  const run = (cmd, opts) => {
    assert.equal(cmd, 'pass show "my vault/item"');
    assert.equal(opts.shell, true);
    return 'p@ss\n';
  };
  assert.equal(resolveCommand({ cmd: 'pass show "my vault/item"' }, { run }), 'p@ss');
});

test('resolveCommand: empty output throws AuthError', () => {
  assert.throws(() => resolveCommand({ cmd: 'op read x' }, { run: () => '' }), AuthError);
});

test('resolveCommand: non-zero exit (run throws) throws AuthError', () => {
  const run = () => { throw new Error('exit 1'); };
  assert.throws(() => resolveCommand({ cmd: 'false' }, { run }), AuthError);
});

// A secret-manager command that debug-prints the password to its own stderr
// on failure must not have that output surface in resolveCommand's AuthError
// message (which reaches `hosts test` output / logs). The message is built
// from the exit code alone — the command's stdout/stderr is never included.
test('resolveCommand: a failing command\'s stderr never appears in the AuthError message', () => {
  const SECRET = 'S3CRET-marker-value';
  // Real defaultShellRun path: exit 1 with the secret on stderr.
  const err = (() => {
    try { resolveCommand({ cmd: `sh -c 'echo ${SECRET} >&2; exit 3'` }); }
    catch (e) { return e; }
  })();
  assert.ok(err instanceof AuthError);
  assert.doesNotMatch(err.message, new RegExp(SECRET), 'command stderr (incl. a secret) must never reach the message');
  assert.match(err.message, /exit 3/, 'the exit code is still surfaced for debugging');

  // Also robust when an injected `run` throws its own message containing output.
  const run = () => { const e = new Error('ignored raw message'); e.status = 7; throw e; };
  try { resolveCommand({ cmd: 'evil-tool' }, { run }); assert.fail('should have thrown'); }
  catch (e) {
    assert.ok(e instanceof AuthError);
    assert.doesNotMatch(e.message, /ignored raw message/, 'the runner\'s raw message is never echoed');
    assert.match(e.message, /exit 7/);
  }
});

test('resolveKeychain: mac uses security -w with service/account on argv, never the secret', () => {
  const mac = resolveKeychain({ service: 'svc', account: 'me' },
    {
      platform: 'darwin',
      run: (b, a) => {
        assert.equal(b, 'security');
        assert.deepEqual(a, ['find-generic-password', '-s', 'svc', '-a', 'me', '-w']);
        return 'mac-pw\n';
      },
    });
  assert.equal(mac, 'mac-pw');
});

test('resolveKeychain: mac miss throws AuthError', () => {
  assert.throws(
    () => resolveKeychain({ service: 's', account: 'a' }, { platform: 'darwin', run: () => { throw new Error('not found'); } }),
    AuthError,
  );
});

test('resolveKeychain: linux has no built-in keychain, throws with --source command guidance', () => {
  assert.throws(
    () => resolveKeychain({ service: 's', account: 'a' }, { platform: 'linux', run: () => '' }),
    /no built-in keychain on linux.*--source command/i,
  );
});

test('resolveKeychain: windows has no built-in keychain, throws with --source command guidance', () => {
  assert.throws(
    () => resolveKeychain({ service: 's', account: 'a' }, { platform: 'win32', run: () => '' }),
    /no built-in keychain on win32.*--source command/i,
  );
});

test('resolveKeychain: linux/windows errors are AuthError with needsAuth', () => {
  for (const platform of ['linux', 'win32']) {
    try {
      resolveKeychain({ service: 's', account: 'a' }, { platform, run: () => '' });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof AuthError, platform);
      assert.equal(e.needsAuth, true, platform);
    }
  }
});

test('resolvePrompt: reads no-echo when TTY; throws when piped', async () => {
  const got = await resolvePrompt({}, { isTTY: true, readSecret: async () => 'typed-pw' });
  assert.equal(got, 'typed-pw');
  await assert.rejects(resolvePrompt({}, { isTTY: false, readSecret: async () => 'x' }), AuthError);
});

test('resolveSecret: dispatches by source', async () => {
  assert.equal(await resolveSecret({ source: 'env', env: 'PW' }, { env: { PW: 'e' } }), 'e');
  assert.equal(await resolveSecret({ source: 'command', cmd: 'echo hi' }, { run: () => 'cmd\n' }), 'cmd');
  assert.equal(
    await resolveSecret({ source: 'keychain', service: 's', account: 'a' }, { platform: 'darwin', run: () => 'kc\n' }),
    'kc',
  );
  assert.equal(
    await resolveSecret({ source: 'prompt' }, { isTTY: true, readSecret: async () => 'typed' }),
    'typed',
  );
});

test('resolveSecret: unknown source throws AuthError', async () => {
  await assert.rejects(resolveSecret({ source: 'nope' }, {}), AuthError);
});

test('_askpass: prints the env-source secret for a host, nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-askpass-'));
  const sd = join(dir, '.unsnooze'); mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'hosts.json'), JSON.stringify({
    gpu: { dest: 'me@gpu', auth: 'password', source: 'env', env: 'UNSNOOZE_PW_GPU' },
  }));
  const out = execFileSync(process.execPath, ['bin/unsnooze.js', '_askpass', 'gpu', 'password for me@gpu:'],
    { env: { ...process.env, UNSNOOZE_STATE_DIR: sd, UNSNOOZE_PW_GPU: 'hunter2' }, encoding: 'utf-8' });
  assert.equal(out.replace(/\r?\n$/, ''), 'hunter2');   // exactly the secret
  rmSync(dir, { recursive: true, force: true });
});

test('_askpass: unknown host / unset secret → exit 1, empty stdout', () => {
  const sd = mkdtempSync(join(tmpdir(), 'unsnooze-askpass2-'));
  let code = 0, out = '';
  try { out = execFileSync(process.execPath, ['bin/unsnooze.js', '_askpass', 'nope'],
    { env: { ...process.env, UNSNOOZE_STATE_DIR: sd }, encoding: 'utf-8' }); }
  catch (e) { code = e.status; out = String(e.stdout || ''); }
  assert.equal(code, 1);
  assert.equal(out, '');
  rmSync(sd, { recursive: true, force: true });
});

// C1 part 2: OpenSSH >=8.4 sets SSH_ASKPASS_PROMPT=confirm for a host-key
// yes/no confirmation, not a password request. With BatchMode dropped (the
// C1 fix), an unknown host now reaches this prompt instead of failing
// closed at BatchMode — the helper must never hand ssh the secret in
// response to a confirm prompt (fail-closed: hint + exit 1).
test('cmdAskpass: SSH_ASKPASS_PROMPT=confirm never emits the secret — hints and exits 1', async () => {
  const { cmdAskpass } = await import('../src/askpass.js');
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-askpass-confirm-'));
  const sd = join(dir, '.unsnooze'); mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'hosts.json'), JSON.stringify({
    gpu: { dest: 'me@gpu', auth: 'password', source: 'env', env: 'UNSNOOZE_PW_GPU' },
  }));
  const origStateDir = process.env.UNSNOOZE_STATE_DIR;
  const origPrompt = process.env.SSH_ASKPASS_PROMPT;
  const origPw = process.env.UNSNOOZE_PW_GPU;
  process.env.UNSNOOZE_STATE_DIR = sd;
  process.env.SSH_ASKPASS_PROMPT = 'confirm';
  process.env.UNSNOOZE_PW_GPU = 'hunter2';
  let stdoutWritten = '';
  let stderrWritten = '';
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  process.stdout.write = (s) => { stdoutWritten += s; return true; };
  process.stderr.write = (s) => { stderrWritten += s; return true; };
  let code;
  try {
    code = await cmdAskpass(['gpu']);
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    if (origStateDir === undefined) delete process.env.UNSNOOZE_STATE_DIR; else process.env.UNSNOOZE_STATE_DIR = origStateDir;
    if (origPrompt === undefined) delete process.env.SSH_ASKPASS_PROMPT; else process.env.SSH_ASKPASS_PROMPT = origPrompt;
    if (origPw === undefined) delete process.env.UNSNOOZE_PW_GPU; else process.env.UNSNOOZE_PW_GPU = origPw;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(code, 1, 'must fail closed');
  assert.equal(stdoutWritten, '', 'the secret must never be emitted for a confirm prompt');
  assert.match(stderrWritten, /host key not yet trusted/i);
  assert.match(stderrWritten, /gpu/);
  assert.doesNotMatch(stdoutWritten + stderrWritten, /hunter2/, 'secret value must never appear anywhere in output');
});

test('cmdAskpass: SSH_ASKPASS_PROMPT=confirm end-to-end via the real subprocess entry point', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-askpass-confirm2-'));
  const sd = join(dir, '.unsnooze'); mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'hosts.json'), JSON.stringify({
    gpu: { dest: 'me@gpu', auth: 'password', source: 'env', env: 'UNSNOOZE_PW_GPU' },
  }));
  let code = 0, out = '', err = '';
  try {
    out = execFileSync(process.execPath, ['bin/unsnooze.js', '_askpass', 'gpu', 'Are you sure?'],
      { env: { ...process.env, UNSNOOZE_STATE_DIR: sd, UNSNOOZE_PW_GPU: 'hunter2', SSH_ASKPASS_PROMPT: 'confirm' }, encoding: 'utf-8' });
  } catch (e) {
    code = e.status;
    out = String(e.stdout || '');
    err = String(e.stderr || '');
  }
  assert.equal(code, 1);
  assert.equal(out, '', 'stdout must be empty — no secret leaks to a confirm prompt');
  assert.match(err, /host key not yet trusted/i);
  rmSync(dir, { recursive: true, force: true });
});

test("ensureAskpassHelper: unix writes an executable shebang wrapper", async () => {
  const { ensureAskpassHelper } = await import('../src/askpass.js');
  const sd = mkdtempSync(join(tmpdir(), 'unsnooze-helper-'));
  const p = ensureAskpassHelper({ platform: 'linux', stateDir: sd, nodePath: '/usr/bin/node', scriptPath: '/x/bin/unsnooze.js' });
  assert.ok(existsSync(p));
  const body = readFileSync(p, 'utf-8');
  assert.match(body, /^#!/);                    // shebang
  assert.match(body, /_askpass/);
  rmSync(sd, { recursive: true, force: true });
});

test('ensureAskpassHelper: unix wrapper is 0700', async () => {
  const { ensureAskpassHelper } = await import('../src/askpass.js');
  const sd = mkdtempSync(join(tmpdir(), 'unsnooze-helper2-'));
  const p = ensureAskpassHelper({ platform: 'darwin', stateDir: sd, nodePath: '/usr/bin/node', scriptPath: '/x/bin/unsnooze.js' });
  const mode = statSync(p).mode & 0o777;
  assert.equal(mode, 0o700);
  rmSync(sd, { recursive: true, force: true });
});

test('ensureAskpassHelper: win32 writes a .cmd wrapper referencing the host env var', async () => {
  const { ensureAskpassHelper } = await import('../src/askpass.js');
  const sd = mkdtempSync(join(tmpdir(), 'unsnooze-helper-win-'));
  const p = ensureAskpassHelper({ platform: 'win32', stateDir: sd, nodePath: 'C:\\node.exe', scriptPath: 'C:\\x\\bin\\unsnooze.js' });
  assert.ok(existsSync(p));
  const body = readFileSync(p, 'utf-8');
  assert.match(body, /_askpass/);
  assert.match(body, /UNSNOOZE_ASKPASS_HOST/);
  rmSync(sd, { recursive: true, force: true });
});

// low-1: the write must be atomic (write-tmp + rename), never a partial
// file visible at the final path, and a stale/wrong mode on a pre-existing
// file must still be corrected back to 0700.
test('ensureAskpassHelper: write is atomic (no leftover tmp files) and re-provisioning a pre-existing file still yields 0700', async () => {
  const { readdirSync, chmodSync } = await import('node:fs');
  const { ensureAskpassHelper } = await import('../src/askpass.js');
  const sd = mkdtempSync(join(tmpdir(), 'unsnooze-helper-atomic-'));
  const p1 = ensureAskpassHelper({ platform: 'darwin', stateDir: sd, nodePath: '/usr/bin/node', scriptPath: '/x/bin/unsnooze.js' });
  assert.deepEqual(readdirSync(sd), ['askpass.sh'], 'no .tmp.* residue after the first write');

  // Simulate a pre-existing file with the wrong mode (e.g. left over from a
  // different umask/version) and re-provision.
  chmodSync(p1, 0o644);
  const p2 = ensureAskpassHelper({ platform: 'darwin', stateDir: sd, nodePath: '/usr/bin/node', scriptPath: '/x/bin/unsnooze.js' });
  assert.equal(p2, p1);
  assert.equal(statSync(p2).mode & 0o777, 0o700, 'pre-existing file must still be corrected to 0700');
  assert.deepEqual(readdirSync(sd), ['askpass.sh'], 'no .tmp.* residue after re-provisioning');
  rmSync(sd, { recursive: true, force: true });
});
