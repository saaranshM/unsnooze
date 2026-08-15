// The headless backend is the mux-free path: no tmux, no pane, no scraping.
// Detection comes from the StopFailure hook and the transcript watcher (both
// already OS-agnostic); this backend only has to answer "is it still alive"
// and "open a fresh one". Every assertion here is about that narrow contract —
// and about the guarantees that keep it from being mistaken for a real pane.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHeadless } from '../src/multiplexers/headless.js';
import { createMultiplexerFactory } from '../src/multiplexer.js';
import { MUX_NAMES } from '../src/config.js';

const tmpDirs = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-headless-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function fakeSpawner() {
  const calls = [];
  const spawner = (file, args, options = {}) => {
    calls.push({ file, args, options });
    return { pid: 4242, unref() { calls.push({ unref: true }); } };
  };
  spawner.calls = calls;
  return spawner;
}

test('headless is always available — there is nothing to install', () => {
  const mux = createHeadless({ platform: 'win32', env: {} });
  assert.equal(mux.available(), true);
  assert.equal(createHeadless({ platform: 'linux', env: {} }).available(), true);
});

test('headless is always "inside" — there is no session to be outside of', () => {
  assert.equal(createHeadless({ env: {} }).inside(), true);
});

test('currentPaneId is null so the launcher skips the pane monitor', () => {
  // src/launcher.js takes the "pane id unset -> no monitor" branch on null.
  // A monitor would scrape capturePane(), which headless cannot answer.
  assert.equal(createHeadless({ env: {} }).currentPaneId(), null);
});

test('capturePane returns empty so the resumer can never authorize typing', async () => {
  const mux = createHeadless({ env: {} });
  assert.equal(await mux.capturePane('pid:1'), '');
  assert.equal(await mux.capturePaneVisible('pid:1'), '');
});

test('sendText and sendKey refuse rather than silently doing nothing', async () => {
  const mux = createHeadless({ env: {} });
  await assert.rejects(() => mux.sendText('pid:1', 'hello'), /headless/i);
  await assert.rejects(() => mux.sendKey('pid:1', 'Enter'), /headless/i);
});

test('newWindow spawns detached and reports a pid address', async () => {
  const dir = scratch();
  const spawner = fakeSpawner();
  const mux = createHeadless({ spawner, logDir: dir, env: {} });

  const address = await mux.newWindow('unsnooze-1', '/work', {
    file: '/usr/bin/node', args: ['bin.js', '_run', 'claude'], env: { FOO: 'bar' },
  });

  assert.deepEqual(address, { pane: 'pid:4242', paneOwner: null, session: 'unsnooze-1' });
  const call = spawner.calls.find(c => c.file);
  assert.equal(call.file, '/usr/bin/node');
  assert.deepEqual(call.args, ['bin.js', '_run', 'claude']);
  assert.equal(call.options.cwd, '/work');
  assert.equal(call.options.detached, true);
  assert.equal(call.options.env.FOO, 'bar');
});

test('newWindow tees output to a per-session log so an unattended run is readable', async () => {
  const dir = scratch();
  const mux = createHeadless({ logDir: dir, env: {} });

  await mux.newWindow('unsnooze-log', process.cwd(), {
    file: process.execPath, args: ['-e', 'console.log("hello from headless")'], env: {},
  });

  const log = join(dir, 'unsnooze-log.log');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(existsSync(log), 'log file should be created');
  assert.match(readFileSync(log, 'utf-8'), /hello from headless/);
});

test('paneAlive tracks the real process behind a pid address', async () => {
  const mux = createHeadless({ env: {} });
  assert.equal(await mux.paneAlive(`pid:${process.pid}`), true);
  // PID 1 exists but is not ours; a pid that cannot exist must read as dead.
  assert.equal(await mux.paneAlive('pid:2147483646'), false);
  assert.equal(await mux.paneAlive('nonsense'), false);
  assert.equal(await mux.paneAlive(null), false);
});

test('closePane kills the process the address names', async () => {
  const killed = [];
  const mux = createHeadless({ env: {}, kill: pid => killed.push(pid) });
  await mux.closePane('pid:1234');
  assert.deepEqual(killed, [1234]);
});

test('headless omits listSessions so reap never claims to own a session', () => {
  // src/reap.js:listOwnedSessions skips any backend without listSessions.
  // Headless has no session registry, so it must not pretend to have one.
  const mux = createHeadless({ env: {} });
  assert.equal(typeof mux.listSessions, 'undefined');
  assert.equal(typeof mux.stampPaneOwner, 'undefined');
});

test('headless is registered as a real multiplexer name', () => {
  assert.ok(MUX_NAMES.includes('headless'));
});

test('headless is the last-resort default and never pre-empts an installed mux', () => {
  const backend = (name, installed) => ({
    name, available: () => installed, inside: () => false, bind() { return this; },
  });
  const backends = {
    tmux: backend('tmux', false),
    zellij: backend('zellij', false),
    herdr: backend('herdr', false),
    cmux: backend('cmux', false),
    headless: backend('headless', true),
  };

  // Nothing installed -> headless, instead of the old unconditional tmux guess.
  let factory = createMultiplexerFactory({ backends, getSetting: () => 'auto', env: {} });
  assert.equal(factory.getMultiplexer().name, 'headless');

  // tmux installed -> tmux still wins; headless must not steal a real pane.
  backends.tmux = backend('tmux', true);
  factory = createMultiplexerFactory({ backends, getSetting: () => 'auto', env: {} });
  assert.equal(factory.getMultiplexer().name, 'tmux');

  // Ambient TMUX env still wins outright.
  factory = createMultiplexerFactory({ backends, getSetting: () => 'auto', env: { TMUX: '/tmp/x' } });
  assert.equal(factory.getMultiplexer().name, 'tmux');

  // An explicit setting is always honoured.
  factory = createMultiplexerFactory({ backends, getSetting: () => 'headless', env: { TMUX: '/tmp/x' } });
  assert.equal(factory.getMultiplexer().name, 'headless');
});

test('headless offers no attach hint — there is no session to attach to', async () => {
  // A headless "session" is a detached pid. Falling through to the default
  // `tmux attach -t <name>` would print a command that either does nothing or,
  // worse, attaches to an unrelated tmux session with a colliding name.
  const { attachHint } = await import('../src/multiplexers/session-name.js');
  assert.equal(attachHint('headless', 'unsnooze-resumed'), null);
  // The backends that do have something joinable still say so.
  assert.match(attachHint('tmux', 'unsnooze-1'), /tmux attach/);
  assert.match(attachHint('herdr', 'unsnooze-1'), /herdr session attach/);
});
