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
    '-s', 'revival', 'run', '--cwd', '/tmp/project', '--',
    '/usr/bin/env', 'LEASE=xyz', 'EMPTY=', '/usr/bin/node', 'agent.js', '--resume', 'abc',
  ]);
  assert.equal(Object.keys(run.options.env).some(key => key.startsWith('ZELLIJ')), false);
});

test('zellij creates a missing session before opening its new pane', async () => {
  const spawner = fakeSpawner((_file, args) => args[0] === 'list-sessions' ? 'main\n' : 'terminal_8\n');
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

test('tmux backend accepts structured launches and returns the canonical address', async () => {
  const spawner = fakeSpawner((_file, args) => {
    if (args[0] === 'has-session') throw new Error('missing');
    if (args[0] === 'new-session') return '%9\n';
    return '';
  });
  const mux = createTmux({ spawner, env: {} });

  assert.deepEqual(await mux.newWindow('revival', '/tmp', {
    file: 'node', args: ['agent.js'], env: { TOKEN: 'value' },
  }), { pane: '%9', paneOwner: 'revival' });
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
  assert.deepEqual(tmuxSpawner.calls[0].args,
    ['new-session', '-s', 'wrapped', '-e', 'TOKEN=x', 'node', 'agent.js']);

  const zellijSpawner = fakeSpawner(() => ({ status: 17 }));
  const zellij = createZellij({
    spawner: zellijSpawner,
    env: { PATH: '/bin', ZELLIJ_SESSION_NAME: 'stale', UNSNOOZE_SESSION_NAME: 'wrapped' },
  });
  assert.equal(zellij.launchWrapped({ file: 'node', args: ['agent.js'], env: { TOKEN: 'x' } }), 17);
  assert.deepEqual(zellijSpawner.calls[0].args.slice(0, 3),
    ['--session', 'wrapped', '--layout-string']);
  assert.match(zellijSpawner.calls[0].args[3], /close_on_exit=true/);
  assert.match(zellijSpawner.calls[0].args[3], /TOKEN=x/);
  assert.equal(Object.keys(zellijSpawner.calls[0].options.env).some(key => key.startsWith('ZELLIJ')), false);
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
