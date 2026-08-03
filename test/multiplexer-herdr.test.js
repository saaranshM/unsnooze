import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHerdr, SUBMIT_DELAY_MS } from '../src/multiplexers/herdr.js';

function fakeSpawner(respond = () => '') {
  const calls = [];
  const spawner = (file, args, options = {}) => {
    calls.push({ file, args, options });
    return respond(file, args, options);
  };
  spawner.calls = calls;
  return spawner;
}

const workspaceCreated = JSON.stringify({
  id: 'cli:workspace:create',
  result: {
    root_pane: {
      agent_status: 'unknown', cwd: '/tmp', focused: false,
      foreground_cwd: '/tmp', pane_id: 'w1:p1', revision: 0,
      scroll: { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 53 },
      tab_id: 'w1:t1', terminal_id: 'term_probe', workspace_id: 'w1',
    },
    tab: { agent_status: 'unknown', focused: false, label: '1', number: 1,
      pane_count: 1, tab_id: 'w1:t1', workspace_id: 'w1' },
    type: 'workspace_created',
    workspace: { active_tab_id: 'w1:t1', agent_status: 'unknown', focused: false,
      label: 'probe', number: 1, pane_count: 1, tab_count: 1, workspace_id: 'w1' },
  },
});

const paneInfo = JSON.stringify({
  id: 'cli:pane:get',
  result: {
    pane: {
      agent_status: 'unknown', cwd: '/tmp', focused: false,
      foreground_cwd: '/tmp', pane_id: 'w1:p1', revision: 0,
      scroll: { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 53 },
      tab_id: 'w1:t1', terminal_id: 'term_probe', workspace_id: 'w1',
    },
    type: 'pane_info',
  },
});

const paneNotFound = JSON.stringify({
  error: { code: 'pane_not_found', message: 'pane w1:p1 not found' },
  id: 'cli:pane:get',
});

const processInfo = JSON.stringify({
  id: 'cli:pane:process-info',
  result: {
    process_info: {
      foreground_processes: [
        { argv: ['/usr/bin/node', 'agent.js'], cmdline: '/usr/bin/node agent.js',
          name: 'node', pid: 101, cwd: '/tmp' },
        { argv: ['/usr/bin/npm', 'exec', '@upstash/cli'], cmdline: 'npm exec @upstash/cli',
          name: 'npm exec @upsta', pid: 202, cwd: '/tmp' },
      ],
      foreground_process_group_id: 202,
      shell_pid: 99,
    },
    type: 'pane_process_info',
  },
});

const processInfoFallback = JSON.stringify({
  id: 'cli:pane:process-info',
  result: {
    process_info: {
      foreground_processes: [
        { argv: ['/opt/bin/claude', '--resume', 'abc'], cmdline: 'claude --resume abc',
          name: 'claude', pid: 303, cwd: '/tmp' },
      ],
      foreground_process_group_id: 999,
      shell_pid: 99,
    },
    type: 'pane_process_info',
  },
});

const paneList = JSON.stringify({
  id: 'cli:pane:list',
  result: {
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/tmp',
        agent: 'claude', agent_status: 'working', terminal_title: 'agent' },
      { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/tmp',
        agent_status: 'unknown', terminal_title: '' },
    ],
    type: 'pane_list',
  },
});

const sessionList = JSON.stringify({
  sessions: [
    { default: true, name: 'default', running: true,
      session_dir: '/home/ubuntu/.config/herdr', socket_path: '/home/ubuntu/.config/herdr/herdr.sock' },
    { default: false, name: 'stopped', running: false,
      session_dir: '/home/ubuntu/.config/herdr/sessions/stopped', socket_path: '/tmp/stopped.sock' },
  ],
});

test('available enforces the herdr 0.7.5 version floor and handles failures', () => {
  const versions = [
    ['herdr 0.7.5\n', true],
    ['herdr 0.7.6\n', true],
    ['herdr 1.0.0\n', true],
    ['herdr 0.7.4\n', false],
    ['herdr 0.6.0\n', false],
  ];
  for (const [stdout, expected] of versions) {
    const mux = createHerdr({
      spawner: fakeSpawner(() => ({ status: 0, stdout })), env: {},
    });
    assert.equal(mux.available(), expected, stdout);
  }
  assert.equal(createHerdr({
    spawner: fakeSpawner(() => ({ status: 1, stdout: 'herdr 0.7.5\n' })), env: {},
  }).available(), false);
  assert.equal(createHerdr({
    spawner: fakeSpawner(() => { throw new Error('not installed'); }), env: {},
  }).available(), false);
  assert.equal(createHerdr({
    spawner: fakeSpawner(() => ({ status: 0, stdout: 'not a version' })), env: {},
  }).available(), false);
});

test('inside and currentPaneId honor herdr identity without cross-backend bleed', () => {
  const ambient = {
    HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SESSION: 'ambient',
    UNSNOOZE_MUX: 'herdr', UNSNOOZE_PANE: 'managed',
  };
  const mux = createHerdr({ spawner: fakeSpawner(), env: ambient });
  assert.equal(mux.inside(), true);
  assert.equal(mux.currentPaneId(), 'managed');

  assert.equal(createHerdr({ spawner: fakeSpawner(), env: {
    HERDR_PANE_ID: 'ambient', UNSNOOZE_MUX: 'zellij', UNSNOOZE_PANE: 'wrong',
  } }).currentPaneId(), 'ambient');
  assert.equal(createHerdr({ spawner: fakeSpawner(), env: {
    UNSNOOZE_MUX: 'herdr', UNSNOOZE_PANE: 'managed',
  } }).currentPaneId(), 'managed');
  assert.equal(createHerdr({ spawner: fakeSpawner(), env: {} }).inside(), false);
  assert.equal(createHerdr({ spawner: fakeSpawner(), env: {} }).currentPaneId(), null);
});

test('owner-bound calls scrub inherited HERDR variables and pass explicit session', async () => {
  const spawner = fakeSpawner(() => 'screen text');
  const mux = createHerdr({
    spawner,
    env: { PATH: '/bin', KEEP: 'yes', HERDR_ENV: '1', HERDR_PANE_ID: 'bad',
      HERDR_SOCKET_PATH: '/bad.sock', HERDR_SESSION: 'wrong' },
  }).bind('OWNER');

  assert.equal(await mux.capturePane('w1:p1', 5), 'screen text');
  assert.deepEqual(spawner.calls[0].args,
    ['--session', 'OWNER', 'pane', 'read', 'w1:p1', '--source', 'recent', '--lines', '5', '--format', 'text']);
  assert.equal(spawner.calls[0].options.env.PATH, '/bin');
  assert.equal(spawner.calls[0].options.env.KEEP, 'yes');
  assert.equal(Object.keys(spawner.calls[0].options.env).some(key => key.startsWith('HERDR')), false);
});

test('capturePaneVisible uses raw visible text args', async () => {
  const spawner = fakeSpawner(() => 'visible\n');
  const mux = createHerdr({ spawner, env: {} }).bind('OWNER');
  assert.equal(await mux.capturePaneVisible('w1:p1'), 'visible\n');
  assert.deepEqual(spawner.calls[0].args,
    ['--session', 'OWNER', 'pane', 'read', 'w1:p1', '--source', 'visible', '--format', 'text']);
});

test('sendText sends literal text and submits after the required delay', async () => {
  const spawner = fakeSpawner(() => '');
  const mux = createHerdr({ spawner, env: {} }).bind('OWNER');
  const started = Date.now();
  await mux.sendText('w1:p1', 'echo hi');
  assert.ok(Date.now() - started >= SUBMIT_DELAY_MS - 10);
  assert.deepEqual(spawner.calls.map(call => call.args), [
    ['--session', 'OWNER', 'pane', 'send-text', 'w1:p1', 'echo hi'],
    ['--session', 'OWNER', 'pane', 'send-keys', 'w1:p1', 'enter'],
  ]);
});

test('sendKey maps named keys and falls back to literal text', async () => {
  const spawner = fakeSpawner(() => '');
  const mux = createHerdr({ spawner, env: {} }).bind('OWNER');
  await mux.sendKey('w1:p1', 'Escape');
  await mux.sendKey('w1:p1', 'ctrl+c');
  assert.deepEqual(spawner.calls.map(call => call.args), [
    ['--session', 'OWNER', 'pane', 'send-keys', 'w1:p1', 'esc'],
    ['--session', 'OWNER', 'pane', 'send-text', 'w1:p1', 'ctrl+c'],
  ]);
});

test('paneAlive accepts a matching pane and rejects pane_not_found or mismatched JSON', async () => {
  let stdout = paneInfo;
  const spawner = fakeSpawner(() => stdout);
  const mux = createHerdr({ spawner, env: {} }).bind('OWNER');
  assert.equal(await mux.paneAlive('w1:p1'), true);
  stdout = paneNotFound;
  assert.equal(await mux.paneAlive('w1:p1'), false);
  stdout = JSON.stringify({ id: 'cli:pane:get', result: { pane: { pane_id: 'w1:p2' } } });
  assert.equal(await mux.paneAlive('w1:p1'), false);
  stdout = undefined;
  const rejecting = createHerdr({ spawner: fakeSpawner(() => { throw new Error('missing'); }), env: {} }).bind('OWNER');
  assert.equal(await rejecting.paneAlive('w1:p1'), false);
});

test('paneCurrentCommand selects the foreground process group and uses argv over truncated comm', async () => {
  let stdout = processInfo;
  const spawner = fakeSpawner(() => stdout);
  const mux = createHerdr({ spawner, env: {} }).bind('OWNER');
  assert.equal(await mux.paneCurrentCommand('w1:p1'), 'npm');
  stdout = processInfoFallback;
  assert.equal(await mux.paneCurrentCommand('w1:p1'), 'claude');
  stdout = JSON.stringify({ id: 'cli:pane:process-info', result: { process_info: {
    foreground_processes: [], foreground_process_group_id: 0, shell_pid: 99,
  } } });
  assert.equal(await mux.paneCurrentCommand('w1:p1'), null);
  stdout = 'not json';
  assert.equal(await mux.paneCurrentCommand('w1:p1'), null);
});

test('sessionForPane returns the expected ambient session identities', async () => {
  assert.equal(await createHerdr({ spawner: fakeSpawner(), env: {
    HERDR_ENV: '1', HERDR_SESSION: 'ambient',
  } }).bind('owner').sessionForPane('w1:p1'), 'owner');
  assert.equal(await createHerdr({ spawner: fakeSpawner(), env: {
    HERDR_ENV: '1', HERDR_SESSION: 'ambient',
  } }).sessionForPane('w1:p1'), 'ambient');
  assert.equal(await createHerdr({ spawner: fakeSpawner(), env: {
    HERDR_PANE_ID: 'w1:p1',
  } }).sessionForPane('w1:p1'), 'default');
  assert.equal(await createHerdr({ spawner: fakeSpawner(), env: {} }).sessionForPane('w1:p1'), null);
});

test('listSessions parses bare session JSON and sessionExists uses it', async () => {
  const spawner = fakeSpawner(() => sessionList);
  const mux = createHerdr({ spawner, env: {} });
  assert.deepEqual(await mux.listSessions(), [
    { name: 'default', exited: false },
    { name: 'stopped', exited: true },
  ]);
  assert.equal(await mux.sessionExists('stopped'), true);
  assert.equal(await mux.sessionExists('missing'), false);
});

test('listSessions returns an empty list on malformed or failed output', async () => {
  assert.deepEqual(await createHerdr({
    spawner: fakeSpawner(() => 'not json'), env: {},
  }).listSessions(), []);
  assert.deepEqual(await createHerdr({
    spawner: fakeSpawner(() => { throw new Error('unreachable'); }), env: {},
  }).listSessions(), []);
});

test('listSessionPanes parses pane ids under an explicit session override', async () => {
  const spawner = fakeSpawner(() => paneList);
  const mux = createHerdr({ spawner, env: {} });
  assert.deepEqual(await mux.listSessionPanes('OWNER'), ['w1:p1', 'w1:p2']);
  assert.deepEqual(spawner.calls[0].args, ['--session', 'OWNER', 'pane', 'list']);
});

test('listSessionPanes returns an empty list on malformed or failed output', async () => {
  assert.deepEqual(await createHerdr({
    spawner: fakeSpawner(() => 'not json'), env: {},
  }).listSessionPanes('OWNER'), []);
  assert.deepEqual(await createHerdr({
    spawner: fakeSpawner(() => { throw new Error('unreachable'); }), env: {},
  }).listSessionPanes('OWNER'), []);
});

test('closePane requires an owner and uses the owner-bound pane close command', async () => {
  await assert.rejects(() => createHerdr({ spawner: fakeSpawner(), env: {} }).closePane('w1:p1'),
    /requires a session owner/);
  const spawner = fakeSpawner(() => JSON.stringify({ result: { type: 'ok' } }));
  await createHerdr({ spawner, env: {} }).bind('OWNER').closePane('w1:p1');
  assert.deepEqual(spawner.calls[0].args, ['--session', 'OWNER', 'pane', 'close', 'w1:p1']);
});

test('deleteSession stops best effort, then deletes the named session', async () => {
  const spawner = fakeSpawner((_file, args) => {
    if (args[1] === 'stop') throw new Error('already stopped');
    return 'deleted session OWNER';
  });
  await createHerdr({ spawner, env: {} }).deleteSession('OWNER');
  assert.deepEqual(spawner.calls.map(call => call.args), [
    ['session', 'stop', 'OWNER'],
    ['session', 'delete', 'OWNER'],
  ]);
});

test('bind creates independent owner-bound backends', async () => {
  const spawner = fakeSpawner(() => '');
  const mux = createHerdr({ spawner, env: {} });
  await mux.bind('one').capturePane('w1:p1');
  await mux.bind('two').capturePane('w1:p1');
  assert.equal(spawner.calls[0].args[1], 'one');
  assert.equal(spawner.calls[1].args[1], 'two');
});

test('herdr does not expose tmux-only tty or ownership methods', () => {
  const mux = createHerdr({ spawner: fakeSpawner(), env: {} });
  for (const method of ['clientTtys', 'paneTty', 'globalEnv', 'stampPaneOwner', 'paneOwnerStamp']) {
    assert.equal(typeof mux[method], 'undefined', method);
  }
});

const noNamedSession = JSON.stringify({
  sessions: [{ default: true, name: 'default', running: true }],
});

const runningNamedSession = JSON.stringify({
  sessions: [
    { default: true, name: 'default', running: true },
    { default: false, name: 'revival', running: true,
      session_dir: '/home/ubuntu/.config/herdr/sessions/revival',
      socket_path: '/home/ubuntu/.config/herdr/sessions/revival/herdr.sock' },
  ],
});

test('ensureSessionRunning starts a detached server and polls until running', async () => {
  let listCalls = 0;
  const spawner = fakeSpawner((_file, args, options) => {
    if (args.join(' ') === 'session list --json') {
      listCalls += 1;
      return listCalls === 1 ? noNamedSession : runningNamedSession;
    }
    if (options.detach) return { pid: 1234, unref() {} };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  });
  const mux = createHerdr({ spawner, env: {} });

  await mux.ensureSessionRunning('revival');
  assert.equal(listCalls, 2);
  assert.deepEqual(spawner.calls[1].args, ['--session', 'revival', 'server']);
  assert.equal(spawner.calls[1].options.detach, true);
  assert.equal(spawner.calls[1].options.detached, true);
  assert.equal(spawner.calls[1].options.stdio, 'ignore');
});

test('ensureSessionRunning does nothing when the named server is already running', async () => {
  const spawner = fakeSpawner((_file, args) => {
    if (args.join(' ') === 'session list --json') return runningNamedSession;
    throw new Error(`unexpected call: ${args.join(' ')}`);
  });
  await createHerdr({ spawner, env: {} }).ensureSessionRunning('revival');
  assert.equal(spawner.calls.length, 1);
});

test('ensureSessionRunning raises SessionCreateError when the server never becomes ready', async () => {
  const spawner = fakeSpawner((_file, args, options) => {
    if (args.join(' ') === 'session list --json') return noNamedSession;
    if (options.detach) return { pid: 1234, unref() {} };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  });
  await assert.rejects(
    () => createHerdr({ spawner, env: {} }).ensureSessionRunning('never'),
    err => err.name === 'SessionCreateError' && /never.*server did not start/.test(err.message),
  );
});

test('newWindow puts whitelisted launch env on workspace, runs bare argv, and submits it', async () => {
  const spawner = fakeSpawner((_file, args, options) => {
    if (args.join(' ') === 'session list --json') return runningNamedSession;
    if (args.includes('workspace') && args.includes('create')) return workspaceCreated;
    if (args.includes('pane') && args.includes('run')) return '';
    if (args.includes('pane') && args.includes('send-keys')) return '';
    if (options.detach) return { pid: 1234, unref() {} };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  });
  const mux = createHerdr({ spawner, env: {} });
  const launchSpec = {
    file: '/usr/bin/node', args: ['agent.js', '--resume', 'abc'],
    env: {
      UNSNOOZE_MUX: 'herdr',
      UNSNOOZE_PANE_OWNER: 'revival',
      UNSNOOZE_MESSAGE: 'hello world "quoted"',
      CLAUDE_CONFIG_DIR: '/tmp/claude-config',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/tmp/claude-secure-storage',
      LEASE: 'xyz', EMPTY: '', OMIT: undefined,
    },
  };

  assert.deepEqual(await mux.newWindow('revival', '/tmp/project', launchSpec), {
    pane: 'w1:p1', paneOwner: 'revival',
  });
  const workspace = spawner.calls.find(call => call.args.includes('workspace'));
  assert.deepEqual(workspace.args, [
    '--session', 'revival', 'workspace', 'create', '--cwd', '/tmp/project', '--label', 'unsnooze',
    '--env', 'UNSNOOZE_MUX=herdr',
    '--env', 'UNSNOOZE_PANE_OWNER=revival',
    '--env', 'UNSNOOZE_MESSAGE=hello world "quoted"',
    '--env', 'CLAUDE_CONFIG_DIR=/tmp/claude-config',
    '--env', 'CLAUDE_SECURESTORAGE_CONFIG_DIR=/tmp/claude-secure-storage',
  ]);
  const run = spawner.calls.find(call => call.args.includes('run'));
  assert.deepEqual(run.args, [
    '--session', 'revival', 'pane', 'run', 'w1:p1',
    '/usr/bin/node', 'agent.js', '--resume', 'abc',
  ]);
  assert.equal(run.args.includes('--'), false);
  const submit = spawner.calls.find(call => call.args.includes('send-keys'));
  assert.deepEqual(submit.args, ['--session', 'revival', 'pane', 'send-keys', 'w1:p1', 'enter']);
});

test('newWindow throws when workspace create has no root pane id', async () => {
  const spawner = fakeSpawner((_file, args) => {
    if (args.join(' ') === 'session list --json') return runningNamedSession;
    if (args.includes('workspace') && args.includes('create')) {
      return JSON.stringify({ id: 'cli:workspace:create', result: { type: 'workspace_created' } });
    }
    throw new Error(`unexpected call: ${args.join(' ')}`);
  });
  await assert.rejects(
    () => createHerdr({ spawner, env: {} }).newWindow('revival', '/tmp', {
      file: 'node', args: [], env: {},
    }),
    /unexpected herdr workspace shape: no root_pane/,
  );
});

function syncLaunchSpawner({ sessions, attachResult = { status: 0 }, onCall = () => {} }) {
  return fakeSpawner((_file, args, options) => {
    onCall(args, options);
    if (args.join(' ') === 'session list --json') {
      const stdout = typeof sessions === 'function' ? sessions() : sessions;
      return { status: 0, stdout };
    }
    if (options.detach) return { pid: 1234, unref() {} };
    if (args.includes('workspace') && args.includes('create')) {
      return { status: 0, stdout: workspaceCreated };
    }
    if (args.includes('pane') && (args.includes('run') || args.includes('send-keys'))) return { status: 0, stdout: '' };
    if (args[0] === 'session' && args[1] === 'attach') return attachResult;
    throw new Error(`unexpected call: ${args.join(' ')}`);
  });
}

test('launchWrapped sidesteps a taken session name and attaches synchronously', () => {
  let listCalls = 0;
  const spawner = syncLaunchSpawner({
    sessions: () => {
      listCalls += 1;
      if (listCalls <= 2) return JSON.stringify({ sessions: [
        { default: true, name: 'default', running: true },
        { default: false, name: 'unsnooze', running: true },
      ] });
      return JSON.stringify({ sessions: [
        { default: true, name: 'default', running: true },
        { default: false, name: 'unsnooze', running: true },
        { default: false, name: 'unsnooze-2', running: true },
      ] });
    },
  });
  const mux = createHerdr({ spawner, env: { UNSNOOZE_SESSION_NAME: 'unsnooze' } });

  assert.equal(mux.launchWrapped({
    file: 'node', args: ['agent.js'],
    env: { UNSNOOZE_LEASE_ID: 'lease with spaces', UNSNOOZE_SESSION_NAME: 'revival', FOO: 'bar' },
  }), 0);
  const workspace = spawner.calls.find(call => call.args.includes('workspace'));
  assert.deepEqual(workspace.args, [
    '--session', 'unsnooze-2', 'workspace', 'create', '--cwd', process.cwd(), '--label', 'unsnooze',
    '--env', 'UNSNOOZE_LEASE_ID=lease with spaces',
    '--env', 'UNSNOOZE_SESSION_NAME=revival',
  ]);
  const run = spawner.calls.find(call => call.args.includes('run'));
  assert.deepEqual(run.args, [
    '--session', 'unsnooze-2', 'pane', 'run', 'w1:p1', 'node', 'agent.js',
  ]);
  const submit = spawner.calls.find(call => call.args.includes('send-keys'));
  assert.deepEqual(submit.args, ['--session', 'unsnooze-2', 'pane', 'send-keys', 'w1:p1', 'enter']);
  const attach = spawner.calls.find(call => call.args[0] === 'session' && call.args[1] === 'attach');
  assert.deepEqual(attach.args, ['session', 'attach', 'unsnooze-2']);
  assert.equal(attach.options.sync, true);
  assert.equal(attach.options.stdio, 'inherit');
  assert.equal(spawner.calls.some(call => call.options.detach), true);
});

test('launchWrapped throws SessionCreateError when attach reports a spawn error', () => {
  let listCalls = 0;
  const cause = new Error('herdr unavailable');
  const spawner = syncLaunchSpawner({
    sessions: () => {
      listCalls += 1;
      return listCalls === 1 ? runningNamedSession : JSON.stringify({ sessions: [
        { default: true, name: 'default', running: true },
        { default: false, name: 'revival', running: true },
        { default: false, name: 'revival-2', running: true },
      ] });
    },
    attachResult: { error: cause },
  });
  const mux = createHerdr({ spawner, env: { UNSNOOZE_SESSION_NAME: 'revival' } });
  assert.throws(
    () => mux.launchWrapped({ file: 'node', args: [], env: {} }),
    err => err.name === 'SessionCreateError' && err.cause === cause && /revival/.test(err.message),
  );
});

test('launchWrapped maps a Ctrl-C attach signal to exit status 130', () => {
  let listCalls = 0;
  const spawner = syncLaunchSpawner({
    sessions: () => {
      listCalls += 1;
      return listCalls === 1 ? runningNamedSession : JSON.stringify({ sessions: [
        { default: true, name: 'default', running: true },
        { default: false, name: 'revival', running: true },
        { default: false, name: 'revival-2', running: true },
      ] });
    },
    attachResult: { status: null, signal: 'SIGINT' },
  });
  const mux = createHerdr({ spawner, env: { UNSNOOZE_SESSION_NAME: 'revival' } });
  assert.equal(mux.launchWrapped({ file: 'node', args: [], env: {} }), 130);
});

test('launchWrapped raises SessionCreateError when headless server startup times out', () => {
  const spawner = syncLaunchSpawner({
    sessions: noNamedSession,
  });
  const mux = createHerdr({ spawner, env: { UNSNOOZE_SESSION_NAME: 'never' } });
  assert.throws(
    () => mux.launchWrapped({ file: 'node', args: [], env: {} }),
    err => err.name === 'SessionCreateError' && /never.*server did not start/.test(err.message),
  );
});

test('launchWrapped keeps Claude recovery roots, but does not encode other env in pane argv', () => {
  let listCalls = 0;
  const spawner = syncLaunchSpawner({
    sessions: () => {
      listCalls += 1;
      return listCalls === 1 ? runningNamedSession : JSON.stringify({ sessions: [
        { default: true, name: 'default', running: true },
        { default: false, name: 'revival', running: true },
        { default: false, name: 'revival-2', running: true },
      ] });
    },
  });
  const mux = createHerdr({ spawner, env: { UNSNOOZE_SESSION_NAME: 'revival' } });
  mux.launchWrapped({ file: 'node', args: [], env: {
    PATH: '/bin', UNSNOOZE_SESSION_NAME: 'revival',
    CLAUDE_CONFIG_DIR: '/tmp/config', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/tmp/secure',
  } });
  const workspace = spawner.calls.find(call => call.args.includes('workspace'));
  assert.deepEqual(workspace.args.slice(-6), [
    '--env', 'UNSNOOZE_SESSION_NAME=revival',
    '--env', 'CLAUDE_CONFIG_DIR=/tmp/config',
    '--env', 'CLAUDE_SECURESTORAGE_CONFIG_DIR=/tmp/secure',
  ]);
  const run = spawner.calls.find(call => call.args.includes('run'));
  assert.deepEqual(run.args.slice(-1), ['node']);
  assert.equal(run.args.includes('/usr/bin/env'), false);
  assert.equal(run.args.includes('PATH=/bin'), false);
  assert.equal(run.args.includes('UNSNOOZE_SESSION_NAME=revival'), false);
});
