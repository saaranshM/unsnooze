// Password source resolvers: env/command/keychain/prompt, dispatch, AuthError.
// Every OS branch is exercised via injected `platform` — no platform-skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
