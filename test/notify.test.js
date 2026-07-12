import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-notify-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { notify } = await import('../src/notify.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

/** Drain microtasks + one macrotask so detached OSC/BEL tails settle. */
const tick = () => new Promise(r => setImmediate(r));

function tmuxMux() {
  return { clientTtys: async () => [], paneTty: async () => '/dev/ttys001' };
}

function zellijMux() {
  return { name: 'zellij' }; // no clientTtys
}

test('darwin uses osascript with escaped strings', () => {
  const calls = [];
  notify('Limit hit', 'session "x" stopped', { platform: 'darwin', spawner: (cmd, args) => calls.push({ cmd, args }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'osascript');
  assert.match(calls[0].args.join(' '), /display notification/);
  assert.ok(!calls[0].args.join(' ').includes('session "x"'), 'quotes must be escaped inside the AppleScript literal');
});

test('linux uses notify-send', () => {
  const calls = [];
  notify('Resumed', 'all good', { platform: 'linux', spawner: (cmd, args) => calls.push({ cmd, args }) });
  assert.equal(calls[0].cmd, 'notify-send');
  assert.deepEqual(calls[0].args.slice(-2), ['Resumed', 'all good']);
});

test('isWsl detects a WSL kernel release string', async () => {
  const { isWsl } = await import('../src/notify.js');
  assert.equal(isWsl('linux', '5.15.167.4-microsoft-standard-WSL2'), true);
  assert.equal(isWsl('linux', '6.8.0-45-generic'), false);
  assert.equal(isWsl('darwin', '23.5.0'), false);
});

test('WSL uses a powershell.exe toast with XML-escaped text', () => {
  const calls = [];
  notify('Limit <hit> & "stuff"', 'msg', {
    platform: 'linux', wsl: true,
    spawner: (cmd, args) => calls.push({ cmd, args }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'powershell.exe');
  const script = calls[0].args.join(' ');
  assert.match(script, /ToastNotificationManager/);
  assert.ok(script.includes('Limit &lt;hit&gt; &amp; &quot;stuff&quot;'), 'title must be XML-escaped');
  assert.ok(!script.includes('Limit <hit>'), 'raw angle brackets must not reach the toast XML');
});

test('native win32 also uses the powershell toast', () => {
  const calls = [];
  notify('t', 'm', { platform: 'win32', spawner: (cmd, args) => calls.push({ cmd, args }) });
  assert.equal(calls[0].cmd, 'powershell.exe');
});

test('notifications toggle off → nothing fires', () => {
  process.env.UNSNOOZE_NOTIFICATIONS = 'off';
  const calls = [];
  notify('x', 'y', { platform: 'darwin', spawner: (cmd, args) => calls.push({ cmd, args }) });
  assert.equal(calls.length, 0);
  delete process.env.UNSNOOZE_NOTIFICATIONS;
});

test('spawner errors are swallowed', () => {
  assert.doesNotThrow(() => notify('x', 'y', { platform: 'linux', spawner: () => { throw new Error('boom'); } }));
});

test('zellij intentionally has no statusline notification fallback', () => {
  const calls = [];
  const oldTmux = process.env.TMUX;
  const oldZellij = process.env.ZELLIJ;
  process.env.TMUX = '/tmp/tmux';
  process.env.ZELLIJ = '0';
  try {
    notify('x', 'y', { platform: 'freebsd', spawner: (cmd, args) => calls.push({ cmd, args }) });
  } finally {
    if (oldTmux === undefined) delete process.env.TMUX; else process.env.TMUX = oldTmux;
    if (oldZellij === undefined) delete process.env.ZELLIJ; else process.env.ZELLIJ = oldZellij;
  }
  assert.deepEqual(calls, []);
});

test('managed tmux uses its fallback even with nested Zellij environment', () => {
  const calls = [];
  const oldTmux = process.env.TMUX;
  const oldZellij = process.env.ZELLIJ;
  const oldMux = process.env.UNSNOOZE_MUX;
  process.env.TMUX = '/tmp/tmux';
  process.env.ZELLIJ = '0';
  process.env.UNSNOOZE_MUX = 'tmux';
  try {
    notify('x', 'y', { platform: 'freebsd', spawner: (cmd, args) => calls.push({ cmd, args }) });
  } finally {
    if (oldTmux === undefined) delete process.env.TMUX; else process.env.TMUX = oldTmux;
    if (oldZellij === undefined) delete process.env.ZELLIJ; else process.env.ZELLIJ = oldZellij;
    if (oldMux === undefined) delete process.env.UNSNOOZE_MUX; else process.env.UNSNOOZE_MUX = oldMux;
  }
  assert.equal(calls[0]?.cmd, 'tmux');
});

// ── channel dispatch ───────────────────────────────────────────────────────

test('channel=osc with deliveries >0 → no native spawner', async () => {
  const calls = [];
  const oscArgs = [];
  notify('Title', 'Body', {
    platform: 'darwin',
    channel: 'osc',
    context: { mux: 'tmux', pane: '%1' },
    getMux: () => tmuxMux(),
    tty: {
      sendOsc: async (title, body, opts) => {
        oscArgs.push({ title, body, opts });
        return 2;
      },
      sendBell: async () => true,
    },
    spawner: (cmd, args) => calls.push({ cmd, args }),
  });
  await tick();
  assert.equal(calls.length, 0, 'native must not fire when OSC delivered');
  assert.equal(oscArgs.length, 1);
  assert.equal(oscArgs[0].title, 'Title');
  assert.equal(oscArgs[0].body, 'Body');
  assert.equal(oscArgs[0].opts.force, true);
  assert.equal(oscArgs[0].opts.pane, '%1');
});

test('channel=osc undeliverable → native fires after microtask', async () => {
  const calls = [];
  notify('t', 'm', {
    platform: 'darwin',
    channel: 'osc',
    context: { mux: 'tmux', pane: '%1' },
    getMux: () => tmuxMux(),
    tty: {
      sendOsc: async () => 0,
      sendBell: async () => true,
    },
    spawner: (cmd, args) => calls.push({ cmd, args }),
  });
  assert.equal(calls.length, 0, 'native must not fire synchronously for async path');
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'osascript');
});

test('channel=bell undeliverable → native fires; deliverable → no native', async () => {
  const failCalls = [];
  notify('t', 'm', {
    platform: 'darwin',
    channel: 'bell',
    context: { mux: 'tmux', pane: '%1' },
    getMux: () => tmuxMux(),
    tty: {
      sendOsc: async () => 0,
      sendBell: async () => false,
    },
    spawner: (cmd, args) => failCalls.push({ cmd, args }),
  });
  await tick();
  assert.equal(failCalls[0]?.cmd, 'osascript');

  const okCalls = [];
  notify('t', 'm', {
    platform: 'darwin',
    channel: 'bell',
    context: { mux: 'tmux', pane: '%1' },
    getMux: () => tmuxMux(),
    tty: {
      sendOsc: async () => 0,
      sendBell: async () => true,
    },
    spawner: (cmd, args) => okCalls.push({ cmd, args }),
  });
  await tick();
  assert.equal(okCalls.length, 0);
});

test('channel=auto + context → OSC + BEL; native only when OSC delivered 0', async () => {
  const oscCalls = [];
  const bellCalls = [];
  const nativeCalls = [];

  // Deliveries > 0: OSC+BEL, no native.
  notify('T', 'B', {
    platform: 'darwin',
    channel: 'auto',
    context: { mux: 'tmux', pane: '%2', paneOwner: 's:0' },
    getMux: (name, opts) => {
      assert.equal(name, 'tmux');
      assert.equal(opts?.owner, 's:0');
      return tmuxMux();
    },
    tty: {
      sendOsc: async (title, body, opts) => {
        oscCalls.push({ title, body, force: opts?.force });
        return 1;
      },
      sendBell: async (opts) => {
        bellCalls.push(opts);
        return true;
      },
    },
    spawner: (cmd, args) => nativeCalls.push({ cmd, args }),
  });
  await tick();
  assert.equal(oscCalls.length, 1);
  assert.equal(oscCalls[0].force, false, 'auto must not force OSC dialect');
  assert.equal(bellCalls.length, 1);
  assert.equal(bellCalls[0].pane, '%2');
  assert.equal(nativeCalls.length, 0, 'native must not double-banner when OSC worked');

  // Deliveries === 0: still BEL, native fallback.
  oscCalls.length = 0;
  bellCalls.length = 0;
  nativeCalls.length = 0;
  notify('T', 'B', {
    platform: 'darwin',
    channel: 'auto',
    context: { mux: 'tmux', pane: '%2' },
    getMux: () => tmuxMux(),
    tty: {
      sendOsc: async () => 0,
      sendBell: async () => {
        bellCalls.push(1);
        return true;
      },
    },
    spawner: (cmd, args) => nativeCalls.push({ cmd, args }),
  });
  await tick();
  assert.equal(bellCalls.length, 1, 'BEL still fires on auto even when OSC is 0');
  assert.equal(nativeCalls.length, 1);
  assert.equal(nativeCalls[0].cmd, 'osascript');
});

test('channel=auto without context → native immediately', () => {
  const calls = [];
  notify('t', 'm', {
    platform: 'darwin',
    channel: 'auto',
    context: null,
    tty: {
      sendOsc: async () => { throw new Error('should not be called'); },
      sendBell: async () => { throw new Error('should not be called'); },
    },
    getMux: () => { throw new Error('should not be called'); },
    spawner: (cmd, args) => calls.push({ cmd, args }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'osascript');
});

test('zellij-shaped mux (no clientTtys) → native sync', () => {
  const calls = [];
  let osc = 0;
  notify('t', 'm', {
    platform: 'darwin',
    channel: 'auto',
    context: { mux: 'zellij', pane: '1' },
    getMux: () => zellijMux(),
    tty: {
      sendOsc: async () => { osc += 1; return 1; },
      sendBell: async () => true,
    },
    spawner: (cmd, args) => calls.push({ cmd, args }),
  });
  assert.equal(osc, 0, 'OSC path must not run without clientTtys');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'osascript');
});

test('notifications=off → nothing on any channel', async () => {
  process.env.UNSNOOZE_NOTIFICATIONS = 'off';
  try {
    const calls = [];
    let osc = 0;
    notify('x', 'y', {
      platform: 'darwin',
      channel: 'osc',
      context: { mux: 'tmux', pane: '%1' },
      getMux: () => tmuxMux(),
      tty: {
        sendOsc: async () => { osc += 1; return 1; },
        sendBell: async () => true,
      },
      spawner: (cmd, args) => calls.push({ cmd, args }),
    });
    await tick();
    assert.equal(calls.length, 0);
    assert.equal(osc, 0);
  } finally {
    delete process.env.UNSNOOZE_NOTIFICATIONS;
  }
});

test('throwing tty channel is swallowed (never rejects caller)', async () => {
  const calls = [];
  assert.doesNotThrow(() => {
    notify('t', 'm', {
      platform: 'darwin',
      channel: 'osc',
      context: { mux: 'tmux', pane: '%1' },
      getMux: () => tmuxMux(),
      tty: {
        sendOsc: async () => { throw new Error('tty boom'); },
        sendBell: async () => { throw new Error('bell boom'); },
      },
      spawner: (cmd, args) => calls.push({ cmd, args }),
    });
  });
  await tick();
  // Undeliverable OSC falls back to native rather than losing the notification.
  assert.equal(calls[0]?.cmd, 'osascript');
});

test('channel=native forces native even with capable context', async () => {
  const calls = [];
  let osc = 0;
  notify('t', 'm', {
    platform: 'darwin',
    channel: 'native',
    context: { mux: 'tmux', pane: '%1' },
    getMux: () => tmuxMux(),
    tty: {
      sendOsc: async () => { osc += 1; return 1; },
      sendBell: async () => true,
    },
    spawner: (cmd, args) => calls.push({ cmd, args }),
  });
  await tick();
  assert.equal(osc, 0);
  assert.equal(calls[0]?.cmd, 'osascript');
});

test('unknown channel string falls back to auto behavior', async () => {
  const calls = [];
  notify('t', 'm', {
    platform: 'darwin',
    channel: 'bogus',
    context: null,
    spawner: (cmd, args) => calls.push({ cmd, args }),
  });
  assert.equal(calls[0]?.cmd, 'osascript');
});
