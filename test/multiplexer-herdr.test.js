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
