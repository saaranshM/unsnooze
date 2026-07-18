// ssh -V parsing (flavor/version → askpass/multiplex capabilities) + discovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSshVersion, detectSsh } from '../src/fleet.js';

test('parseSshVersion: version + flavor → capabilities', () => {
  const linux = parseSshVersion('OpenSSH_9.6p1, LibreSSL 3.3.6');
  assert.deepEqual(
    { flavor: linux.flavor, askpass: linux.askpass, multiplex: linux.multiplex },
    { flavor: 'unix', askpass: true, multiplex: true });

  const winNative = parseSshVersion('OpenSSH_for_Windows_8.6p1, LibreSSL 3.4.3');
  assert.equal(winNative.flavor, 'native-windows');
  assert.equal(winNative.multiplex, false);   // ControlMaster hard-errors here
  assert.equal(winNative.askpass, true);       // 8.6 ≥ 8.4

  const old = parseSshVersion('OpenSSH_8.1p1, OpenSSL 1.1.1');
  assert.equal(old.askpass, false);            // < 8.4: no REQUIRE=force
  assert.equal(old.multiplex, true);

  // Git-Bash / WSL report plain OpenSSH_ even on Windows → unix-like
  assert.equal(parseSshVersion('OpenSSH_9.5p1, LibreSSL').flavor, 'unix');

  const junk = parseSshVersion('not ssh');
  assert.equal(junk.ok, false);
  assert.equal(junk.askpass, false);
  assert.equal(junk.multiplex, false);
});

test('detectSsh: Windows probes System32/Git when PATH ssh missing; parses -V from stderr', () => {
  const calls = [];
  const info = detectSsh({
    platform: 'win32',
    existsSync: (p) => p === 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    run: (bin, args) => { calls.push([bin, args]); return 'OpenSSH_for_Windows_8.6p1, LibreSSL'; },
    cache: false,
  });
  assert.equal(info.bin, 'C:\\Windows\\System32\\OpenSSH\\ssh.exe');
  assert.equal(info.flavor, 'native-windows');
  assert.equal(info.multiplex, false);
  assert.deepEqual(calls.at(-1)[1], ['-V']);
});

test('detectSsh: unix uses PATH ssh', () => {
  const info = detectSsh({
    platform: 'linux', existsSync: () => false,
    run: () => 'OpenSSH_9.6p1, LibreSSL', cache: false,
  });
  assert.equal(info.bin, 'ssh');
  assert.equal(info.multiplex, true);
});
