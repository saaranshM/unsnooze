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

test('available enforces the herdr 0.8.0 version floor and handles failures', () => {
  const versions = [
    ['herdr 0.8.0\n', true],
    ['herdr 0.8.1\n', true],
    ['herdr 1.0.0\n', true],
    // 0.7.x is what Homebrew still ships; the backend is only verified against
    // 0.8.0, so it declines rather than half-working.
    ['herdr 0.7.9\n', false],
    ['herdr 0.7.3\n', false],
    ['herdr 0.6.0\n', false],
  ];
  for (const [stdout, expected] of versions) {
    const mux = createHerdr({
      spawner: fakeSpawner(() => ({ status: 0, stdout })), env: {},
    });
    assert.equal(mux.available(), expected, stdout);
  }
  assert.equal(createHerdr({
    spawner: fakeSpawner(() => ({ status: 1, stdout: 'herdr 0.8.0\n' })), env: {},
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
  // `detection`, not `recent` (an over-tall read makes herdr mouse-scroll an
  // idle alternate-screen agent through its transcript, moving the user's
  // view) and not `visible` (which follows the user's scroll position, so a
  // scrolled-up pane would be judged on stale history).
  assert.deepEqual(spawner.calls[0].args,
    ['--session', 'OWNER', 'pane', 'read', 'w1:p1', '--source', 'detection', '--format', 'text']);
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

test('herdr does not expose the tty methods it has no equivalent for', () => {
  const mux = createHerdr({ spawner: fakeSpawner(), env: {} });
  for (const method of ['clientTtys', 'paneTty', 'globalEnv']) {
    assert.equal(typeof mux[method], 'undefined', method);
  }
});

test('a pane is stamped with the lease that owns it, and the stamp reads back', async () => {
  const spawner = fakeSpawner((_file, args) => {
    if (args.includes('get')) {
      return JSON.stringify({ result: { pane: { pane_id: 'w1:p1', tokens: { unsnooze_owner: 'lease-7' } } } });
    }
    return '';
  });
  const mux = createHerdr({ spawner, env: {} }).bind('OWNER');

  assert.equal(await mux.stampPaneOwner('w1:p1', 'lease-7'), true);
  assert.deepEqual(spawner.calls[0].args, ['--session', 'OWNER', 'pane', 'report-metadata', 'w1:p1',
    '--source', 'unsnooze', '--token', 'unsnooze_owner=lease-7']);
  assert.equal(await mux.paneOwnerStamp('w1:p1'), 'lease-7');
});

test('an unstamped pane reports no owner rather than guessing', async () => {
  const mux = createHerdr({
    spawner: fakeSpawner(() => JSON.stringify({ result: { pane: { pane_id: 'w1:p1' } } })),
    env: {},
  }).bind('OWNER');
  assert.equal(await mux.paneOwnerStamp('w1:p1'), null);
});

test('a failed stamp is reported, never thrown into a launch', async () => {
  const mux = createHerdr({
    spawner: fakeSpawner(() => { throw new Error('herdr gone'); }),
    env: {},
  }).bind('OWNER');
  assert.equal(await mux.stampPaneOwner('w1:p1', 'lease-7'), false);
  assert.equal(await mux.paneOwnerStamp('w1:p1'), null);
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

test('newWindow puts whitelisted launch env on workspace and types ONE quoted command line', async () => {
  const spawner = fakeSpawner((_file, args, options) => {
    if (args.join(' ') === 'session list --json') return runningNamedSession;
    // Nothing herdr has open is on /tmp/project, so this revival is the
    // workspace-creating path.
    if (args.join(' ').endsWith('pane list')) return paneList;
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
    pane: 'w1:p1', paneOwner: 'revival', session: 'revival',
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
  // `pane run` joins its operands with spaces and types the result into the
  // pane's shell, so everything after the pane id must be a single argument we
  // quoted ourselves.
  const run = spawner.calls.find(call => call.args.includes('run'));
  assert.deepEqual(run.args, [
    '--session', 'revival', 'pane', 'run', 'w1:p1',
    "'/usr/bin/node' 'agent.js' '--resume' 'abc'",
  ]);
  // ...and herdr presses Enter itself. A second one lands in the stdin of the
  // program that just started.
  assert.equal(spawner.calls.filter(call => call.args.includes('send-keys')).length, 0,
    'no explicit submit: pane run carries keys:["Enter"] upstream');
});

test('newWindow throws when workspace create has no root pane id', async () => {
  const spawner = fakeSpawner((_file, args) => {
    if (args.join(' ') === 'session list --json') return runningNamedSession;
    if (args.join(' ').endsWith('pane list')) return paneList;
    if (args.includes('workspace') && args.includes('create')) {
      return JSON.stringify({ id: 'cli:workspace:create', result: { type: 'workspace_created' } });
    }
    throw new Error(`unexpected call: ${args.join(' ')}`);
  });
  await assert.rejects(
    () => createHerdr({ spawner, env: {} }).newWindow('revival', '/srv/elsewhere', {
      file: 'node', args: [], env: {},
    }),
    /unexpected herdr workspace shape: no root_pane/,
  );
});

// A herdr workspace is the project, not the window — it is per repo, the way a
// tmux SESSION is. Reviving used to `workspace create` every time, so one repo
// accumulated a new top-level workspace on every reset (#15).
const projectPaneList = JSON.stringify({
  id: 'cli:pane:list',
  result: {
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/home/you/other',
        agent_status: 'unknown' },
      // Trailing slash on herdr's side, none on ours: the same directory.
      { pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1', cwd: '/srv/project/',
        agent: 'claude', agent_status: 'working' },
      { pane_id: 'w3:p1', workspace_id: 'w3', tab_id: 'w3:t1', cwd: '/tmp',
        foreground_cwd: '/srv/project', agent_status: 'unknown' },
    ],
    type: 'pane_list',
  },
});

const tabCreated = JSON.stringify({
  id: 'cli:tab:create',
  result: {
    root_pane: {
      agent_status: 'unknown', cwd: '/srv/project', focused: false,
      foreground_cwd: '/srv/project', pane_id: 'w2:p7', revision: 0,
      tab_id: 'w2:t3', terminal_id: 'term_revive', workspace_id: 'w2',
    },
    tab: { agent_status: 'unknown', focused: false, label: 'unsnooze', number: 3,
      pane_count: 1, tab_id: 'w2:t3', workspace_id: 'w2' },
    type: 'tab_created',
  },
});

test('newWindow opens a tab in the workspace already on this project, not a new workspace', async () => {
  const spawner = fakeSpawner((_file, args, options) => {
    if (args.join(' ') === 'session list --json') return runningNamedSession;
    if (args.join(' ').endsWith('pane list')) return projectPaneList;
    if (args.includes('tab') && args.includes('create')) return tabCreated;
    if (args.includes('pane') && args.includes('run')) return '';
    if (options.detach) return { pid: 1234, unref() {} };
    throw new Error(`unexpected call: ${args.join(' ')}`);
  });
  const mux = createHerdr({ spawner, env: {} });

  assert.deepEqual(await mux.newWindow('revival', '/srv/project', {
    file: '/usr/bin/node', args: ['agent.js'],
    env: { UNSNOOZE_MUX: 'herdr', CLAUDE_CONFIG_DIR: '/tmp/claude-config' },
  }), { pane: 'w2:p7', paneOwner: 'revival', session: 'revival' });

  // w2, not w1 (a different project) and not w3 (matched only via a foreground
  // cwd, which the earlier row already beat) — and the launch env still rides
  // on the created terminal, exactly as it did on a workspace.
  const tab = spawner.calls.find(call => call.args.includes('tab'));
  assert.deepEqual(tab.args, [
    '--session', 'revival', 'tab', 'create', '--workspace', 'w2',
    '--cwd', '/srv/project', '--label', 'unsnooze',
    '--env', 'UNSNOOZE_MUX=herdr',
    '--env', 'CLAUDE_CONFIG_DIR=/tmp/claude-config',
  ]);
  assert.equal(spawner.calls.some(call => call.args.includes('workspace')), false,
    'no top-level workspace is created for a project herdr already has open');
  const run = spawner.calls.find(call => call.args.includes('run'));
  assert.deepEqual(run.args, [
    '--session', 'revival', 'pane', 'run', 'w2:p7', "'/usr/bin/node' 'agent.js'",
  ]);
});

test('newWindow matches a project by a pane foreground cwd when no launch cwd does', async () => {
  const spawner = fakeSpawner((_file, args, options) => {
    if (args.join(' ') === 'session list --json') return runningNamedSession;
    if (args.join(' ').endsWith('pane list')) return JSON.stringify({
      result: { panes: [{ pane_id: 'w3:p1', workspace_id: 'w3', cwd: '/tmp',
        foreground_cwd: '/srv/project' }] },
    });
    if (args.includes('tab') && args.includes('create')) return tabCreated;
    if (options.detach) return { pid: 1234, unref() {} };
    return '';
  });
  await createHerdr({ spawner, env: {} })
    .newWindow('revival', '/srv/project', { file: 'node', args: [], env: {} });
  const tab = spawner.calls.find(call => call.args.includes('tab'));
  assert.deepEqual(tab.args.slice(0, 6),
    ['--session', 'revival', 'tab', 'create', '--workspace', 'w3']);
});

test('newWindow creates a workspace when the matched one closed under it', async () => {
  const spawner = fakeSpawner((_file, args, options) => {
    if (args.join(' ') === 'session list --json') return runningNamedSession;
    if (args.join(' ').endsWith('pane list')) return projectPaneList;
    if (args.includes('tab') && args.includes('create')) {
      throw new Error('workspace_not_found: workspace w2 not found');
    }
    if (args.includes('workspace') && args.includes('create')) return workspaceCreated;
    if (options.detach) return { pid: 1234, unref() {} };
    return '';
  });
  const address = await createHerdr({ spawner, env: {} })
    .newWindow('revival', '/srv/project', { file: 'node', args: [], env: {} });
  // A revival into a fresh workspace still revives; failing the revival does not.
  assert.equal(address.pane, 'w1:p1');
  assert.equal(spawner.calls.some(call =>
    call.args.includes('workspace') && call.args.includes('create')), true);
  assert.equal(spawner.calls.some(call => call.args.includes('run')), true);
});

test('newWindow creates a workspace when herdr cannot be asked what it has open', async () => {
  const spawner = fakeSpawner((_file, args, options) => {
    if (args.join(' ') === 'session list --json') return runningNamedSession;
    if (args.join(' ').endsWith('pane list')) return 'not json';
    if (args.includes('workspace') && args.includes('create')) return workspaceCreated;
    if (options.detach) return { pid: 1234, unref() {} };
    return '';
  });
  const address = await createHerdr({ spawner, env: {} })
    .newWindow('revival', '/srv/project', { file: 'node', args: [], env: {} });
  assert.equal(address.pane, 'w1:p1');
});

function syncLaunchSpawner({ sessions, attachResult = { status: 0 },
  runResult = { status: 0, stdout: '' }, onCall = () => {} }) {
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
    if (args.includes('pane') && (args.includes('run') || args.includes('send-keys'))) return runResult;
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
    '--session', 'unsnooze-2', 'pane', 'run', 'w1:p1', "'node' 'agent.js'",
  ]);
  assert.equal(spawner.calls.filter(call => call.args.includes('send-keys')).length, 0,
    'pane run submits on its own');
  const attach = spawner.calls.find(call => call.args[0] === 'session' && call.args[1] === 'attach');
  assert.deepEqual(attach.args, ['session', 'attach', 'unsnooze-2']);
  assert.equal(attach.options.sync, true);
  assert.equal(attach.options.stdio, 'inherit');
  assert.equal(spawner.calls.some(call => call.options.detach), true);
});

test('launchWrapped reports a post-dispatch attach failure as AgentDispatchedError', () => {
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
  // The agent is already running in the session by the time attach fails, so
  // this must NOT be the error class that makes the launcher run it again.
  assert.throws(
    () => mux.launchWrapped({ file: 'node', args: [], env: {} }),
    err => err.name === 'AgentDispatchedError' && err.cause === cause
      && err.session === 'revival-2' && /attaching/.test(err.message),
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
  assert.deepEqual(run.args.slice(-1), ["'node'"]);
  assert.equal(run.args.includes('/usr/bin/env'), false);
  assert.equal(run.args.some(arg => arg.includes('PATH=/bin')), false);
  assert.equal(run.args.some(arg => arg.includes('UNSNOOZE_SESSION_NAME=revival')), false);
});

test('newWindow quotes every argument, whatever the resume message contains', async () => {
  const spawner = fakeSpawner((_file, args, options) => {
    if (args.join(' ') === 'session list --json') return runningNamedSession;
    if (args.includes('workspace')) return workspaceCreated;
    if (options.detach) return { pid: 1234, unref() {} };
    return '';
  });
  const mux = createHerdr({ spawner, env: {} });
  await mux.newWindow('revival', '/tmp/my project', {
    file: '/opt/my tools/node',
    args: ['_run', 'codex', 'resume', '01J', 'Continue where you left off; $(id) & `id` | tee /tmp/x', ''],
    env: {},
  });
  const run = spawner.calls.find(call => call.args.includes('run'));
  assert.equal(run.args.length, 6, 'everything after the pane id is ONE argument');
  assert.equal(run.args[5],
    "'/opt/my tools/node' '_run' 'codex' 'resume' '01J' "
    + "'Continue where you left off; $(id) & `id` | tee /tmp/x' ''");
});

test('newWindow carries a multi-line message as environment instead of typing it', async () => {
  const spawner = fakeSpawner((_file, args, options) => {
    if (args.join(' ') === 'session list --json') return runningNamedSession;
    if (args.includes('workspace')) return workspaceCreated;
    if (options.detach) return { pid: 1234, unref() {} };
    return '';
  });
  const mux = createHerdr({ spawner, env: {} });
  const message = 'line one\nline two\tindented';
  await mux.newWindow('revival', '/tmp', {
    file: 'node', args: ['_run', 'codex', 'resume', '01J', message], env: {},
  });

  // The value never appears in the typed line — a newline there would submit
  // half a command, and a tab would be a completion request.
  const run = spawner.calls.find(call => call.args.includes('run'));
  assert.equal(run.args[5], `'node' '_run' 'codex' 'resume' '01J' "$UNSNOOZE_ARGV_5"`);
  assert.equal(run.args.some(arg => arg.includes('\n')), false);

  // It rides on the workspace instead, where herdr passes it as real argv.
  const workspace = spawner.calls.find(call => call.args.includes('workspace'));
  const index = workspace.args.indexOf('--env');
  assert.ok(workspace.args.includes(`UNSNOOZE_ARGV_5=${message}`),
    `the message travels in the environment: ${JSON.stringify(workspace.args.slice(index))}`);
});

test('a null byte still cannot be delivered at all', async () => {
  const spawner = fakeSpawner((_file, args, options) => {
    if (args.join(' ') === 'session list --json') return runningNamedSession;
    if (args.includes('workspace')) return workspaceCreated;
    if (options.detach) return { pid: 1234, unref() {} };
    return '';
  });
  const mux = createHerdr({ spawner, env: {} });
  await assert.rejects(
    () => mux.newWindow('revival', '/tmp', { file: 'node', args: ['-e', 'a\u0000b'], env: {} }),
    err => err.name === 'UnquotableArgError' && /null byte/.test(err.message),
  );
  assert.equal(spawner.calls.some(call => call.args.includes('run')), false,
    'nothing was dispatched into the pane');
});

test('captureScrollback is the only path that asks herdr for history', async () => {
  const spawner = fakeSpawner(() => 'history');
  const mux = createHerdr({ spawner, env: {} }).bind('OWNER');
  assert.equal(await mux.captureScrollback('w1:p1', 200), 'history');
  assert.deepEqual(spawner.calls[0].args, ['--session', 'OWNER', 'pane', 'read', 'w1:p1',
    '--source', 'recent', '--lines', '200', '--format', 'text']);
});

test('a monitor decision never asks for a line count herdr would answer by scrolling', async () => {
  const spawner = fakeSpawner(() => 'text');
  const mux = createHerdr({ spawner, env: {} }).bind('OWNER');
  await mux.capturePane('w1:p1', 200);
  assert.equal(spawner.calls[0].args.includes('--lines'), false,
    'detection is viewport-bounded; passing --lines would imply a tall read');
  assert.equal(spawner.calls[0].args.includes('recent'), false);
});

test('the env scrub removes routing variables and keeps the user settings', async () => {
  const spawner = fakeSpawner(() => 'text');
  const env = {
    PATH: '/bin', KEEP: 'yes',
    // routing: these decide which server and pane a command reaches
    HERDR_ENV: '1', HERDR_PANE_ID: 'w9:p9', HERDR_SESSION: 'wrong',
    HERDR_SOCKET_PATH: '/tmp/other.sock', HERDR_CLIENT_SOCKET_PATH: '/tmp/other-client.sock',
    HERDR_TAB_ID: 'w9:t9', HERDR_WORKSPACE_ID: 'w9',
    // settings: the user chose these on purpose and a prefix scrub ate them
    HERDR_CONFIG_PATH: '/home/me/herdr.toml', HERDR_LOG: 'debug',
    HERDR_DISABLE_SOUND: '1', HERDR_PROCESS_DETECTION: 'off', HERDR_BIN_PATH: '/opt/herdr',
  };
  await createHerdr({ spawner, env }).bind('OWNER').capturePane('w1:p1');
  const passed = spawner.calls[0].options.env;
  assert.deepEqual(passed, {
    PATH: '/bin', KEEP: 'yes',
    HERDR_CONFIG_PATH: '/home/me/herdr.toml', HERDR_LOG: 'debug',
    HERDR_DISABLE_SOUND: '1', HERDR_PROCESS_DETECTION: 'off', HERDR_BIN_PATH: '/opt/herdr',
  });
});

test('paneAddressable compares the ambient socket against the session it would address', () => {
  const sessions = JSON.stringify({ sessions: [
    { name: 'default', running: true, socket_path: '/home/me/.config/herdr/herdr.sock' },
    { name: 'work', running: true, socket_path: '/tmp/work/herdr.sock' },
  ] });
  const listing = () => ({ status: 0, stdout: sessions });

  // No custom socket: default resolution, nothing to disagree with.
  assert.equal(createHerdr({ spawner: fakeSpawner(listing), env: {} }).paneAddressable(), true);

  // Custom socket that IS the session we address: same server, safe.
  assert.equal(createHerdr({ spawner: fakeSpawner(listing), env: {
    HERDR_SOCKET_PATH: '/tmp/work/herdr.sock', HERDR_PANE_ID: 'w1:p1',
  } }).bind('work').paneAddressable(), true);

  // Custom socket belonging to a DIFFERENT server than the session we address:
  // pane ids are per-server, so this is the wrong-terminal case.
  assert.equal(createHerdr({ spawner: fakeSpawner(listing), env: {
    HERDR_SOCKET_PATH: '/tmp/work/herdr.sock', HERDR_PANE_ID: 'w1:p1',
  } }).bind('default').paneAddressable(), false);

  // Session not in the listing, or herdr unreachable: fail closed.
  assert.equal(createHerdr({ spawner: fakeSpawner(listing), env: {
    HERDR_SOCKET_PATH: '/tmp/work/herdr.sock',
  } }).bind('ghost').paneAddressable(), false);
  assert.equal(createHerdr({ spawner: fakeSpawner(() => { throw new Error('down'); }), env: {
    HERDR_SOCKET_PATH: '/tmp/work/herdr.sock',
  } }).bind('work').paneAddressable(), false);
});

test('the refusal explains itself in terms the user can act on', () => {
  const mux = createHerdr({
    spawner: fakeSpawner(() => ({ status: 0, stdout: JSON.stringify({ sessions: [] }) })),
    env: { HERDR_SOCKET_PATH: '/tmp/work/herdr.sock' },
  }).bind('work');
  assert.match(mux.addressabilityReason(), /HERDR_SOCKET_PATH=\/tmp\/work\/herdr\.sock/);
  assert.match(mux.addressabilityReason(), /work/);
});

// herdr keeps stopped sessions listed and will restart one by name, so a
// stopped session is a TAKEN name, not a free one.
const stoppedUnsnooze = JSON.stringify({ sessions: [
  { default: true, name: 'default', running: true },
  { default: false, name: 'unsnooze', running: false },
] });

test('a stopped session is a taken name, not a free one', () => {
  const calls = [];
  const spawner = fakeSpawner((_file, args, options) => {
    calls.push(args.join(' '));
    if (args.join(' ') === 'session list --json') return { status: 0, stdout: stoppedUnsnooze };
    if (options.detach) return { pid: 1, unref() {} };
    if (args.includes('workspace')) return { status: 0, stdout: workspaceCreated };
    return { status: 0, stdout: '' };
  });
  const mux = createHerdr({ spawner, env: { UNSNOOZE_SESSION_NAME: 'unsnooze' } });
  try { mux.launchWrapped({ file: 'node', args: [], env: {} }); } catch { /* attach is faked away */ }

  assert.equal(calls.some(c => c === '--session unsnooze server'), false,
    'the user\'s stopped session must never be restarted out from under them');
  assert.ok(calls.some(c => c.includes('--session unsnooze-2')),
    'a free name is used instead');
});

test('newWindow revives into a fresh session rather than restarting a stopped one', async () => {
  let started = false;   // the server the driver starts must then show up
  const spawner = fakeSpawner((_file, args, options) => {
    if (args.join(' ') === 'session list --json') {
      return JSON.stringify({ sessions: [
        { default: true, name: 'default', running: true },
        { default: false, name: 'unsnooze', running: false },
        ...(started ? [{ default: false, name: 'unsnooze-2', running: true }] : []),
      ] });
    }
    if (options.detach) { started = true; return { pid: 1, unref() {} }; }
    if (args.includes('workspace')) return workspaceCreated;
    return '';
  });
  const mux = createHerdr({ spawner, env: {} });
  const address = await mux.newWindow('unsnooze', '/tmp', { file: 'node', args: [], env: {} });
  assert.equal(address.session, 'unsnooze-2', 'the caller is told which session it really got');
  assert.equal(address.paneOwner, 'unsnooze-2');
  assert.equal(spawner.calls.some(call => call.args.join(' ') === '--session unsnooze server'), false);
});

test('ensureSessionRunning refuses to restart a stopped session, and says why', async () => {
  const spawner = fakeSpawner(() => stoppedUnsnooze);
  const mux = createHerdr({ spawner, env: {} });
  await assert.rejects(
    () => mux.ensureSessionRunning('unsnooze'),
    err => err.name === 'SessionCreateError' && /stopped/.test(err.message) && /resume them twice/.test(err.message),
  );
});

test('a failed pane run is treated as dispatched — keystrokes cannot be unsent', () => {
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
    runResult: { status: 1, stderr: 'pane run failed' },
  });
  const mux = createHerdr({ spawner, env: { UNSNOOZE_SESSION_NAME: 'revival' } });
  assert.throws(
    () => mux.launchWrapped({ file: 'node', args: [], env: {} }),
    err => err.name === 'AgentDispatchedError' && err.session === 'revival-2',
  );
});

test('a failure BEFORE dispatch stays a SessionCreateError, so the agent can still run unwatched', () => {
  const spawner = syncLaunchSpawner({ sessions: noNamedSession });
  const mux = createHerdr({ spawner, env: { UNSNOOZE_SESSION_NAME: 'never' } });
  assert.throws(
    () => mux.launchWrapped({ file: 'node', args: [], env: {} }),
    err => err.name === 'SessionCreateError',
  );
});

test('an undeliverable argument fails before dispatch, not after', () => {
  const spawner = syncLaunchSpawner({ sessions: () => runningNamedSession });
  const mux = createHerdr({ spawner, env: { UNSNOOZE_SESSION_NAME: 'revival' } });
  assert.throws(
    () => mux.launchWrapped({ file: 'node', args: ['-e', 'a\u0000b'], env: {} }),
    err => err.name === 'SessionCreateError',
  );
  assert.equal(spawner.calls.some(call => call.args.includes('run')), false,
    'nothing was typed into a pane');
});
