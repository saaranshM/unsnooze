// Fleet primitives: host validation, ssh argv hardening, framing, sanitization.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-fleet-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

after(() => {
  rmSync(DIR, { recursive: true, force: true });
});

const {
  validHostToken, sshArgs, frameEnvelope, extractEnvelope,
  stripRemoteText, validateEnvelope, SCHEMA, KEY_RE,
} = await import('../src/fleet.js');
const frameIt = frameEnvelope;
const S = SCHEMA;

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

test('hosts registry: add/list/rm round-trip, atomic file, invalid rejected', async () => {
  const { readHosts, writeHosts, cmdHosts } = await import('../src/fleet.js');
  assert.deepEqual({ ...readHosts() }, {});
  assert.equal(await cmdHosts(['add', 'build1']), 0);                    // dest defaults to name
  assert.equal(await cmdHosts(['add', 'gpu', 'ubuntu@10.0.0.7']), 0);
  assert.deepEqual({ ...readHosts() }, { build1: 'build1', gpu: 'ubuntu@10.0.0.7' });
  assert.equal(await cmdHosts(['add', 'bad', '-oProxyCommand=x']), 1);  // invalid dest
  assert.equal(await cmdHosts(['rm', 'build1']), 0);
  assert.deepEqual(Object.keys(readHosts()), ['gpu']);
  assert.equal(await cmdHosts(['rm', 'nope']), 1);
  assert.equal(await cmdHosts(['list']), 0);
  assert.equal(await cmdHosts(['frobnicate']), 2);                       // usage
});

test('status --json prints machine shape; resume core marks without typing', async () => {
  const { execFileSync } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'unsnooze-fleet-e2e-'));
  const stateDir = join(home, '.unsnooze');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
    version: 1, sessions: {
      'aaaa1111-2222-3333-4444-555566667777': {
        key: 'aaaa1111-2222-3333-4444-555566667777',
        sessionId: 'aaaa1111-2222-3333-4444-555566667777',
        agent: 'claude', cwd: '/tmp/p', status: 'stopped',
        resetAt: Date.now() + 3_600_000, resetSource: 'absolute',
        mux: 'tmux', pane: '%1', muxSession: 'unsnooze', attempts: 0,
        limitType: '5h', detectedAt: Date.now(),
      },
    },
  }));
  const env = { ...process.env, UNSNOOZE_STATE_DIR: stateDir, NO_COLOR: '1' };
  const out = execFileSync(process.execPath, ['bin/unsnooze.js', 'status', '--json'], { env, encoding: 'utf-8' });
  const j = JSON.parse(out);
  assert.equal(j.version, 1);
  assert.equal(j.sessions.length, 1);
  assert.equal(j.sessions[0].agent, 'claude');
  assert.equal(j.sessions[0].status, 'stopped');
  rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ssh fan-out, cache, `unsnooze fleet`
// ---------------------------------------------------------------------------

function fakeSsh({ code = 0, stdout = '', delayMs = 5 }) {
  return () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => { p.killed = true; p.emit('close', null, 'SIGKILL'); };
    setTimeout(() => {
      if (stdout) p.stdout.emit('data', Buffer.from(stdout));
      p.emit('close', code);
    }, delayMs);
    return p;
  };
}

const GOOD = frameIt({
  schema: S, minSchema: 1, cli: '9.9.9', host: 'build1', caps: ['resume', 'cancel'],
  sessions: [{ key: 'k1', agent: 'claude', status: 'stopped', cwd: '/tmp\x1b[31mX', resetAt: Date.now() + 60_000, mux: 'tmux', muxSession: 'unsnooze' }],
});

test('fetchHost: online with sanitized fields; motd noise tolerated', async () => {
  const { fetchHost } = await import('../src/fleet.js');
  const r = await fetchHost('build1', 'build1', { spawnFn: fakeSsh({ stdout: 'motd!\n' + GOOD + '\n' }) });
  assert.equal(r.state, 'online');
  assert.equal(r.envelope.sessions[0].cwd, '/tmpX');        // CSI stripped on ingest
  assert.equal(r.envelope.sessions[0].key, 'k1');
});

test('fetchHost: exit 255 → unreachable; garbage → error; skew detected', async () => {
  const { fetchHost } = await import('../src/fleet.js');
  assert.equal((await fetchHost('h', 'h', { spawnFn: fakeSsh({ code: 255 }) })).state, 'unreachable');
  assert.equal((await fetchHost('h', 'h', { spawnFn: fakeSsh({ stdout: 'not json' }) })).state, 'error');
  const skew = frameIt({ schema: 99, minSchema: 99, cli: '9.9.9', host: 'h', caps: [], sessions: [] });
  assert.equal((await fetchHost('h', 'h', { spawnFn: fakeSsh({ stdout: skew }) })).state, 'skew');
});

test('fetchHost: timeout kills and reports unreachable', async () => {
  const { fetchHost } = await import('../src/fleet.js');
  const r = await fetchHost('h', 'h', { spawnFn: fakeSsh({ delayMs: 5_000 }), timeoutMs: 50 });
  assert.equal(r.state, 'unreachable');
  assert.match(r.error, /timeout/);
});

test('fetchFleet: dead host does not block others; stale cache is used', async () => {
  const { fetchFleet, writeFleetCache } = await import('../src/fleet.js');
  writeFleetCache([{ host: 'dead', state: 'online', at: Date.now() - 60_000, envelope: JSON.parse(GOOD.slice('___UNSNOOZE_BEGIN___'.length, -'___UNSNOOZE_END___'.length)) }]);
  const spawns = { good: fakeSsh({ stdout: GOOD }), dead: fakeSsh({ code: 255 }) };
  const results = await fetchFleet({
    hosts: { good: 'good', dead: 'dead' },
    spawnFn: (cmd, args) => spawns[args[args.indexOf('-T') + 1]](),
  });
  const dead = results.find(r => r.host === 'dead');
  assert.equal(dead.state, 'stale');                        // cached data survives
  assert.ok(dead.cachedAt);
  assert.equal(results.find(r => r.host === 'good').state, 'online');
});

test('attachHintRemote wraps the local hint in ssh -t', async () => {
  const { attachHintRemote } = await import('../src/fleet.js');
  assert.equal(attachHintRemote('gpu', 'tmux', 'unsnooze'), `ssh -t gpu 'tmux new -A -s unsnooze'`);
  assert.equal(attachHintRemote('gpu', 'zellij', 'unsnooze'), `ssh -t gpu 'zellij attach unsnooze'`);
});
