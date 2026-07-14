import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTmux } from '../src/multiplexers/tmux.js';
import { createZellij } from '../src/multiplexers/zellij.js';
import { createMultiplexerFactory } from '../src/multiplexer.js';
import { DEFAULTS, getConfig, setConfigValue } from '../src/settings.js';

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

function fakeSpawner(respond = () => '') {
  const calls = [];
  const spawner = (file, args, options = {}) => {
    calls.push({ file, args, options });
    return respond(file, args, options);
  };
  spawner.calls = calls;
  return spawner;
}

function fakeBackend(name, { installed = true } = {}) {
  return {
    name,
    available: () => installed,
    inside: () => false,
    bind(owner) { return { ...this, owner }; },
  };
}

test('factory resolution order is explicit, setting, environment, only installed, tmux-first', () => {
  const tmux = fakeBackend('tmux');
  const zellij = fakeBackend('zellij');

  let setting = 'zellij';
  let env = { ZELLIJ: '0', TMUX: '/tmp/tmux' };
  let factory = createMultiplexerFactory({ backends: { tmux, zellij }, getSetting: () => setting, env });
  assert.equal(factory.getMultiplexer('tmux').name, 'tmux');
  assert.equal(factory.getMultiplexer().name, 'zellij');

  setting = 'auto';
  assert.equal(factory.getMultiplexer().name, 'zellij');
  env = { TMUX: '/tmp/tmux' };
  factory = createMultiplexerFactory({ backends: { tmux, zellij }, getSetting: () => setting, env });
  assert.equal(factory.getMultiplexer().name, 'tmux');

  env = {};
  factory = createMultiplexerFactory({
    backends: { tmux: fakeBackend('tmux', { installed: false }), zellij },
    getSetting: () => 'auto',
    env,
  });
  assert.equal(factory.getMultiplexer().name, 'zellij');

  factory = createMultiplexerFactory({ backends: { tmux, zellij }, getSetting: () => 'auto', env });
  assert.equal(factory.getMultiplexer().name, 'tmux');
});

test('multiplexer setting is registered and enum-validated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-mux-setting-'));
  process.env.UNSNOOZE_STATE_DIR = dir;
  try {
    assert.equal(DEFAULTS.multiplexer, 'auto');
    assert.equal(getConfig('multiplexer'), 'auto');
    assert.equal(setConfigValue('multiplexer', 'zellij'), 'zellij');
    assert.equal(getConfig('multiplexer'), 'zellij');
    assert.throws(() => setConfigValue('multiplexer', 'screen'), /one of/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zellij owner-bound capture uses exact pane args and scrubs inherited ZELLIJ env', async () => {
  const env = { PATH: '/bin', KEEP: 'yes', ZELLIJ: '0', ZELLIJ_SESSION_NAME: 'wrong', ZELLIJ_PANE_ID: '9' };
  const spawner = fakeSpawner(() => 'screen text');
  const mux = createZellij({ spawner, env }).bind('OWNER');

  assert.equal(await mux.capturePane('7'), 'screen text');
  assert.deepEqual(spawner.calls[0].args,
    ['-s', 'OWNER', 'action', 'dump-screen', '--pane-id', '7']);
  assert.equal(spawner.calls[0].options.env.PATH, '/bin');
  assert.equal(spawner.calls[0].options.env.KEEP, 'yes');
  assert.equal(Object.keys(spawner.calls[0].options.env).some(key => key.startsWith('ZELLIJ')), false);
});

test('zellij Escape falls back to raw write byte', async () => {
  const spawner = fakeSpawner(() => '');
  const mux = createZellij({ spawner, env: {} }).bind('main');

  await mux.sendKey('3', 'Escape');
  assert.deepEqual(spawner.calls[0].args,
    ['-s', 'main', 'action', 'write', '--pane-id', '3', '27']);
});

test('zellij uses supported named keys and falls back to raw bytes when rejected', async () => {
  const spawner = fakeSpawner((_file, args) => {
    if (args.includes('send-keys')) throw new Error('unsupported key');
    return '';
  });
  const mux = createZellij({ spawner, env: {} }).bind('main');

  await mux.sendKey('3', 'Down');
  assert.deepEqual(spawner.calls[0].args,
    ['-s', 'main', 'action', 'send-keys', '--pane-id', '3', 'Down']);
  assert.deepEqual(spawner.calls[1].args,
    ['-s', 'main', 'action', 'write', '--pane-id', '3', '27', '91', '66']);
});

test('currentPaneId prefers matching unsnooze context without crossing backend boundaries', () => {
  const tmuxEnv = {
    TMUX_PANE: '%ambient', ZELLIJ_PANE_ID: '8',
    UNSNOOZE_MUX: 'tmux', UNSNOOZE_PANE: '%managed',
  };
  assert.equal(createTmux({ spawner: fakeSpawner(), env: tmuxEnv }).currentPaneId(), '%managed');
  assert.equal(createZellij({ spawner: fakeSpawner(), env: tmuxEnv }).currentPaneId(), '8');

  const zellijEnv = { ...tmuxEnv, UNSNOOZE_MUX: 'zellij', UNSNOOZE_PANE: '4' };
  assert.equal(createTmux({ spawner: fakeSpawner(), env: zellijEnv }).currentPaneId(), '%ambient');
  assert.equal(createZellij({ spawner: fakeSpawner(), env: zellijEnv }).currentPaneId(), '4');
});

test('zellij paneAlive requires an exact live terminal JSON entry', async () => {
  const panes = [
    { id: 1, is_plugin: false, exited: false },
    { id: 10, is_plugin: false, exited: false },
    { id: 2, is_plugin: true, exited: false },
    { id: 3, is_plugin: false, exited: true },
  ];
  const mux = createZellij({ spawner: fakeSpawner(() => JSON.stringify(panes)), env: {} }).bind('main');

  assert.equal(await mux.paneAlive('1'), true);
  assert.equal(await mux.paneAlive('2'), false);
  assert.equal(await mux.paneAlive('3'), false);
  assert.equal(await mux.paneAlive('0'), false);
});

test('zellij paneCurrentCommand returns basename of the executable token, ignoring args', async () => {
  const cases = [
    ['/opt/bin/claude', 'claude'],
    ['claude --resume abc123', 'claude'],           // real reopen command carries args
    ["node -e const fs=require('fs')", 'node'],      // wrapped/stub launch carries args
    ['/usr/bin/node agent.js --resume x', 'node'],   // full path + args
    ['/snap/yazi/907/yazi', 'yazi'],
  ];
  for (const [pane_command, expected] of cases) {
    const panes = [{ id: 4, is_plugin: false, exited: false, pane_command }];
    const mux = createZellij({ spawner: fakeSpawner(() => JSON.stringify(panes)), env: {} }).bind('main');
    assert.equal(await mux.paneCurrentCommand('4'), expected, `for pane_command="${pane_command}"`);
  }
});

test('zellij newWindow encodes env in argv and parses terminal id with its new owner', async () => {
  const spawner = fakeSpawner((_file, args) => {
    if (args[0] === 'list-sessions') return 'other\nrevival\n';
    if (args.includes('run')) return 'terminal_42\n';
    return '';
  });
  const mux = createZellij({ spawner, env: { ZELLIJ_SESSION_NAME: 'stale', PATH: '/bin' } }).bind('original');

  const created = await mux.newWindow('revival', '/tmp/project', {
    file: '/usr/bin/node', args: ['agent.js', '--resume', 'abc'], env: { LEASE: 'xyz', EMPTY: '' },
  });

  assert.deepEqual(created, { pane: '42', paneOwner: 'revival' });
  const run = spawner.calls.find(call => call.args.includes('run'));
  assert.deepEqual(run.args, [
    '-s', 'revival', 'run', '--close-on-exit', '--cwd', '/tmp/project', '--',
    '/usr/bin/env', 'LEASE=xyz', 'EMPTY=', '/usr/bin/node', 'agent.js', '--resume', 'abc',
  ]);
  assert.equal(Object.keys(run.options.env).some(key => key.startsWith('ZELLIJ')), false);
});

test('zellij creates a missing session before opening its new pane', async () => {
  const spawner = fakeSpawner((_file, args) => {
    if (args[0] === 'list-sessions') return 'main\n';
    if (args[0] === 'attach') return '';
    if (args.includes('list-panes')) return JSON.stringify([{ id: 3, is_plugin: false, exited: false }]);
    if (args.includes('run')) return 'terminal_8\n';
    if (args.includes('close-pane')) return '';
    return '';
  });
  const mux = createZellij({ spawner, env: {} }).bind('main');

  assert.deepEqual(await mux.newWindow('revival', '/tmp', { file: 'claude', args: [], env: {} }),
    { pane: '8', paneOwner: 'revival' });
  assert.deepEqual(spawner.calls[1].args, ['attach', '-b', '-c', 'revival']);
});

test('owner binding is isolated across sequential resolutions with the same pane id', async () => {
  const spawner = fakeSpawner(() => '');
  const zellij = createZellij({ spawner, env: {} });
  const factory = createMultiplexerFactory({
    backends: { tmux: fakeBackend('tmux'), zellij }, getSetting: () => 'auto', env: {},
  });

  await factory.getMultiplexer('zellij', { owner: 'one' }).capturePane('1');
  await factory.getMultiplexer('zellij', { owner: 'two' }).capturePane('1');
  assert.equal(spawner.calls[0].args[1], 'one');
  assert.equal(spawner.calls[1].args[1], 'two');
});

test('tmux backend accepts structured launches and returns paneOwner null', async () => {
  const spawner = fakeSpawner((_file, args) => {
    if (args[0] === 'has-session') throw new Error('missing');
    if (args[0] === 'new-session') return '%9\n';
    return '';
  });
  const mux = createTmux({ spawner, env: {} });

  // tmux pane ids are server-global — paneOwner must stay null so leases match.
  assert.deepEqual(await mux.newWindow('revival', '/tmp', {
    file: 'node', args: ['agent.js'], env: { TOKEN: 'value' },
  }), { pane: '%9', paneOwner: null });
  assert.deepEqual(spawner.calls[1].args, [
    'new-session', '-d', '-s', 'revival', '-c', '/tmp', '-P', '-F', '#{pane_id}',
    '-e', 'TOKEN=value', 'node', 'agent.js',
  ]);
  assert.equal(typeof mux.launchWrapped, 'function');
});

test('launchWrapped names the session, preserves structured argv/env, and returns exit status', () => {
  const tmuxSpawner = fakeSpawner(() => ({ status: 23 }));
  const tmux = createTmux({
    spawner: tmuxSpawner,
    env: { PATH: '/bin', UNSNOOZE_SESSION_NAME: 'wrapped' },
  });
  assert.equal(tmux.launchWrapped({ file: 'node', args: ['agent.js'], env: { TOKEN: 'x' } }), 23);
  // calls[0] is the has-session probe that keeps the name free of collisions.
  // Live discovery (sessionForPane) supersedes env injection — do not inject
  // UNSNOOZE_SESSION_NAME into the child (would leak into spawned daemons).
  assert.deepEqual(tmuxSpawner.calls.at(-1).args,
    ['new-session', '-s', 'wrapped', '-e', 'TOKEN=x', 'node', 'agent.js']);

  const zellijSpawner = fakeSpawner(() => ({ status: 17 }));
  const zellij = createZellij({
    spawner: zellijSpawner,
    env: { PATH: '/bin', ZELLIJ_SESSION_NAME: 'stale', UNSNOOZE_SESSION_NAME: 'wrapped' },
  });
  assert.equal(zellij.launchWrapped({ file: 'node', args: ['agent.js'], env: { TOKEN: 'x' } }), 17);
  // calls[0] is the list-sessions probe that keeps the name free of collisions.
  const launch = zellijSpawner.calls.at(-1);
  assert.deepEqual(launch.args.slice(0, 3), ['--session', 'wrapped', '--layout-string']);
  assert.match(launch.args[3], /close_on_exit=true/);
  assert.match(launch.args[3], /TOKEN=x/);
  assert.equal(launch.args[3].includes('UNSNOOZE_SESSION_NAME'), false);
  assert.equal(Object.keys(launch.options.env).some(key => key.startsWith('ZELLIJ')), false);
});

test('launchWrapped sidesteps a taken session name instead of dying on a duplicate', () => {
  // tmux/zellij both refuse a session name that is already live ("duplicate
  // session: unsnooze"), so a second concurrent `unsnooze <agent>` must land in
  // its own session rather than colliding with the first one.
  const tmuxSpawner = fakeSpawner((_file, args) => {
    if (args[0] === 'has-session') {
      return { status: args[2] === 'unsnooze' || args[2] === 'unsnooze-2' ? 0 : 1 };
    }
    return { status: 0 };
  });
  const tmux = createTmux({ spawner: tmuxSpawner, env: { PATH: '/bin' } });

  assert.equal(tmux.launchWrapped({ file: 'node', args: ['agent.js'], env: {} }), 0);
  const tmuxLaunch = tmuxSpawner.calls.at(-1).args;
  assert.deepEqual(tmuxLaunch.slice(0, 3), ['new-session', '-s', 'unsnooze-3']);
  assert.equal(tmuxLaunch.some(a => String(a).startsWith('UNSNOOZE_SESSION_NAME=')), false);

  const zellijSpawner = fakeSpawner((_file, args, options) => {
    if (args[0] === 'list-sessions') {
      return options.sync ? { status: 0, stdout: 'unsnooze\nother\n' } : 'unsnooze\nother\n';
    }
    return { status: 0 };
  });
  const zellij = createZellij({ spawner: zellijSpawner, env: { PATH: '/bin' } });

  assert.equal(zellij.launchWrapped({ file: 'node', args: ['agent.js'], env: {} }), 0);
  const zellijLaunch = zellijSpawner.calls.at(-1).args;
  assert.deepEqual(zellijLaunch.slice(0, 2), ['--session', 'unsnooze-2']);
  assert.equal(zellijLaunch[3].includes('UNSNOOZE_SESSION_NAME'), false);
});

test('launchWrapped keeps the base name when nothing holds it', () => {
  const spawner = fakeSpawner((_file, args) => (
    args[0] === 'has-session' ? { status: 1 } : { status: 0 }
  ));
  createTmux({ spawner, env: { PATH: '/bin' } }).launchWrapped({ file: 'node', args: [], env: {} });
  assert.deepEqual(spawner.calls.at(-1).args.slice(0, 3), ['new-session', '-s', 'unsnooze']);
});

test('tmux sessionForPane reads #{session_name} and treats blank/error as null', async () => {
  const spawner = fakeSpawner(() => 'main\n');
  const mux = createTmux({ spawner, env: {} });
  assert.equal(await mux.sessionForPane('%1'), 'main');
  assert.deepEqual(spawner.calls[0].args,
    ['display-message', '-t', '%1', '-p', '#{session_name}']);
  assert.equal(await createTmux({ spawner: fakeSpawner(() => '\n'), env: {} }).sessionForPane('%1'), null);
  assert.equal(await createTmux({
    spawner: fakeSpawner(() => { throw new Error('gone'); }), env: {},
  }).sessionForPane('%1'), null);
});

test('zellij sessionForPane returns the bound owner (or ambient env)', async () => {
  const z = createZellij({ spawner: fakeSpawner(() => ''), env: { ZELLIJ_SESSION_NAME: 'ambient' } });
  assert.equal(await z.sessionForPane('1'), 'ambient');
  assert.equal(await z.bind('owned').sessionForPane('1'), 'owned');
});

test('zellij newWindow adds --close-on-exit and closes the default shell pane', async () => {
  let panesListed = 0;
  const spawner = fakeSpawner((_file, args) => {
    if (args[0] === 'list-sessions') return 'main\n';
    if (args[0] === 'attach') return '';
    if (args.includes('list-panes')) {
      panesListed += 1;
      // Default shell pane created by attach -b -c
      return JSON.stringify([{ id: 1, is_plugin: false, exited: false, pane_command: 'zsh' }]);
    }
    if (args.includes('run')) return 'terminal_9\n';
    if (args.includes('close-pane')) return '';
    return '';
  });
  const mux = createZellij({ spawner, env: {} }).bind('main');
  const created = await mux.newWindow('revival', '/tmp', { file: 'claude', args: [], env: {} });
  assert.deepEqual(created, { pane: '9', paneOwner: 'revival' });
  const run = spawner.calls.find(c => c.args.includes('run'));
  assert.ok(run.args.includes('--close-on-exit'));
  const close = spawner.calls.find(c => c.args.includes('close-pane'));
  assert.ok(close, 'default shell pane must be closed after agent pane is added');
  assert.ok(close.args.includes('terminal_1'));
  assert.ok(panesListed >= 1);
});

test('launchWrapped maps Ctrl-C termination to the conventional exit status', () => {
  const spawner = fakeSpawner(() => ({ status: null, signal: 'SIGINT' }));
  assert.equal(createTmux({ spawner, env: {} }).launchWrapped({ file: 'claude', args: [], env: {} }), 130);
});

test('backend probes retain their public surfaces', () => {
  const tmuxSpawner = fakeSpawner(() => ({ status: 0 }));
  const zellijSpawner = fakeSpawner(() => ({ status: 0 }));
  assert.equal(createTmux({ spawner: tmuxSpawner, env: { TMUX: '/tmp/tmux' } }).available(), true);
  assert.equal(createTmux({ spawner: tmuxSpawner, env: { TMUX: '/tmp/tmux' } }).inside(), true);
  assert.equal(createZellij({ spawner: zellijSpawner, env: { ZELLIJ: '0' } }).available(), true);
  assert.equal(createZellij({ spawner: zellijSpawner, env: { ZELLIJ: '0' } }).inside(), true);
});

test('tmux paneAlive requires the target to echo its pane id back (3.7b exits 0 for missing panes)', async () => {
  // tmux 3.7b prints a blank line and exits 0 for a nonexistent -t target, so
  // the exit code alone is not evidence of liveness.
  const blank = createTmux({ spawner: fakeSpawner(() => '\n'), env: {} });
  assert.equal(await blank.paneAlive('%999'), false);
  const real = createTmux({ spawner: fakeSpawner(() => '%42\n'), env: {} });
  assert.equal(await real.paneAlive('%42'), true);
  const erroring = createTmux({ spawner: fakeSpawner(() => { throw new Error('no server'); }), env: {} });
  assert.equal(await erroring.paneAlive('%1'), false);
});

test('tmux clientTtys parses list-clients rows and returns [] on error or detach', async () => {
  const spawner = fakeSpawner(() => '/dev/ttys001\txterm-256color\n/dev/ttys002\tscreen-256color\n');
  const mux = createTmux({ spawner, env: {} });
  assert.deepEqual(await mux.clientTtys('%1'), [
    { tty: '/dev/ttys001', termname: 'xterm-256color' },
    { tty: '/dev/ttys002', termname: 'screen-256color' },
  ]);
  assert.deepEqual(spawner.calls[0].args,
    ['list-clients', '-t', '%1', '-F', '#{client_tty}\t#{client_termname}']);

  // Tty-only row (no tab / empty termname) still yields a client entry.
  const ttyOnly = createTmux({ spawner: fakeSpawner(() => '/dev/ttys009\n'), env: {} });
  assert.deepEqual(await ttyOnly.clientTtys('%1'), [
    { tty: '/dev/ttys009', termname: '' },
  ]);

  const empty = createTmux({ spawner: fakeSpawner(() => ''), env: {} });
  assert.deepEqual(await empty.clientTtys('%1'), []);

  const erroring = createTmux({
    spawner: fakeSpawner(() => { throw new Error('no clients'); }),
    env: {},
  });
  assert.deepEqual(await erroring.clientTtys('%1'), []);
});

test('tmux paneTty returns the path or null on empty/error', async () => {
  const spawner = fakeSpawner(() => '/dev/ttys003\n');
  const mux = createTmux({ spawner, env: {} });
  assert.equal(await mux.paneTty('%7'), '/dev/ttys003');
  assert.deepEqual(spawner.calls[0].args,
    ['display-message', '-t', '%7', '-p', '#{pane_tty}']);

  const blank = createTmux({ spawner: fakeSpawner(() => '\n'), env: {} });
  assert.equal(await blank.paneTty('%7'), null);

  const erroring = createTmux({
    spawner: fakeSpawner(() => { throw new Error('no server'); }),
    env: {},
  });
  assert.equal(await erroring.paneTty('%7'), null);
});

test('tmux globalEnv filters names, skips -REMOVED, and returns {} on error', async () => {
  const envOut = [
    'DISPLAY=:0',
    'SSH_AUTH_SOCK=/tmp/agent.sock',
    'TERM -REMOVED',
    'COLORTERM=truecolor',
    'GONE -REMOVED',
    'FOO=bar=baz',
  ].join('\n') + '\n';
  const spawner = fakeSpawner(() => envOut);
  const mux = createTmux({ spawner, env: {} });
  assert.deepEqual(await mux.globalEnv(['DISPLAY', 'TERM', 'COLORTERM', 'MISSING', 'FOO']), {
    DISPLAY: ':0',
    COLORTERM: 'truecolor',
    FOO: 'bar=baz',
  });
  assert.deepEqual(spawner.calls[0].args, ['show-environment', '-g']);

  // Empty name list is a no-op — no show-environment spawn.
  const idle = fakeSpawner(() => 'SHOULD_NOT_RUN=1\n');
  assert.deepEqual(await createTmux({ spawner: idle, env: {} }).globalEnv(), {});
  assert.deepEqual(await createTmux({ spawner: idle, env: {} }).globalEnv([]), {});
  assert.equal(idle.calls.length, 0);

  const erroring = createTmux({
    spawner: fakeSpawner(() => { throw new Error('no server'); }),
    env: {},
  });
  assert.deepEqual(await erroring.globalEnv(['DISPLAY']), {});
});

test('zellij backend does not expose tmux tty discovery methods', () => {
  const mux = createZellij({ spawner: fakeSpawner(), env: {} });
  assert.equal(typeof mux.clientTtys, 'undefined');
  assert.equal(typeof mux.paneTty, 'undefined');
  assert.equal(typeof mux.globalEnv, 'undefined');
});
