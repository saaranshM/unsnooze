// Fleet primitives: host validation, ssh argv hardening, framing, sanitization.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-fleet-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

const {
  validHostToken, sshArgs, frameEnvelope, extractEnvelope,
  stripRemoteText, validateEnvelope, SCHEMA, KEY_RE,
} = await import('../src/fleet.js');

test('validHostToken: ssh aliases yes, option-injection and metachars no', () => {
  for (const ok of ['build1', 'user@10.0.0.5', 'vpc-a.internal', 'dev_box.example.com']) {
    assert.equal(validHostToken(ok), true, ok);
  }
  for (const bad of ['-oProxyCommand=evil', '--fake', 'host name', 'a;rm -rf /', 'h`x`', '$(x)', '', 'a\nb']) {
    assert.equal(validHostToken(bad), false, JSON.stringify(bad));
  }
});

test('sshArgs: hardening flags fixed, in order, before the host; never StrictHostKeyChecking', () => {
  const args = sshArgs('build1', ['status']);
  const hostIdx = args.indexOf('build1');
  assert.ok(hostIdx > 0, 'host present');
  const flags = args.slice(0, hostIdx).join(' ');
  assert.match(flags, /BatchMode=yes/);
  assert.match(flags, /ConnectTimeout=5/);
  assert.match(flags, /ControlMaster=auto/);
  assert.match(flags, /ControlPersist=60s/);
  assert.ok(args.includes('-T'), 'no TTY on data calls');
  assert.ok(!flags.includes('StrictHostKeyChecking'), 'never touches host-key policy');
  // remote command rides after the host as a single argv tail
  assert.deepEqual(args.slice(hostIdx + 1), ['unsnooze', '_remote', 'status']);
  assert.throws(() => sshArgs('-oProxyCommand=evil', ['status']), /invalid host/);
  assert.throws(() => sshArgs('build1', ['resume', 'bad;key']), /invalid remote arg/);
});

test('frame/extract round-trips and survives motd noise; garbage → null', () => {
  const framed = frameEnvelope({ schema: SCHEMA, hello: 1 });
  assert.equal(extractEnvelope('Welcome to Ubuntu!\n' + framed + '\ntrailing rc noise').hello, 1);
  assert.equal(extractEnvelope('no frame here'), null);
  assert.equal(extractEnvelope('___UNSNOOZE_BEGIN___{broken json___UNSNOOZE_END___'), null);
});

test('stripRemoteText: kills CSI/OSC/C0/C1 and caps length', () => {
  assert.equal(stripRemoteText('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(stripRemoteText('\x1b]0;title\x07cwd'), 'cwd');            // OSC + BEL
  assert.equal(stripRemoteText('\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\'), 'link'); // OSC 8 + ST
  assert.equal(stripRemoteText('a\x9bXb'), 'ab');                          // C1 CSI
  assert.equal(stripRemoteText('a\x07\x08b'), 'ab');                       // bare C0
  assert.equal(stripRemoteText('x'.repeat(500), 100).length, 100);
  assert.equal(stripRemoteText(null), '');
});

test('validateEnvelope: schema window, skew detected, junk rejected', () => {
  const good = { schema: 1, minSchema: 1, cli: '1.13.0', host: 'build1', caps: [], sessions: [] };
  assert.equal(validateEnvelope(good).ok, true);
  assert.equal(validateEnvelope({ schema: 99, minSchema: 99 }).ok, false);
  assert.match(validateEnvelope({ schema: 99, minSchema: 99 }).reason, /skew/);
  assert.equal(validateEnvelope(null).ok, false);
  assert.equal(validateEnvelope({ schema: 'x' }).ok, false);
});

test('KEY_RE accepts real session keys, rejects shell metachars', () => {
  assert.match('92d6f63d-5374-4efc-8181-3218435612d2', KEY_RE);
  assert.match('pane:abc123:1784200000000', KEY_RE);
  assert.doesNotMatch('key;rm -rf', KEY_RE);
  assert.doesNotMatch('a b', KEY_RE);
});
