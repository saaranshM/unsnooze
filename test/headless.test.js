// The headless backend is the mux-free path: no tmux, no pane, no scraping.
// Detection comes from the StopFailure hook and the transcript watcher (both
// already OS-agnostic); this backend only has to answer "is it still alive"
// and "open a fresh one". Every assertion here is about that narrow contract —
// and about the guarantees that keep it from being mistaken for a real pane.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
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

// --- exit records (#25) ---------------------------------------------------
// With no pane to capture, the only honest answer to "did the revive work" is
// what became of the process. These run with a scripted child so they hold on
// Windows too; test/headless-revive.test.js drives the real thing.

function scriptedSpawner(pid = 5150) {
  const handlers = {};
  const spawner = () => ({ pid, unref() {}, on(ev, fn) { handlers[ev] = fn; } });
  spawner.exit = (code, signal = null) => handlers.exit?.(code, signal);
  spawner.error = err => handlers.error?.(err);
  return spawner;
}

test('paneOutcome reports a recorded non-zero exit with the child\'s own output', async () => {
  const dir = scratch();
  const spawner = scriptedSpawner(5150);
  const alive = pid => pid !== 5150;
  const mux = createHeadless({ spawner, alive, logDir: dir, env: {} });
  // An earlier revival into the same session name already wrote here; the
  // record must not blame this child for that.
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'unsnooze-resumed.log'), 'older revival: agent started\n');

  const { pane } = await mux.newWindow('unsnooze-resumed', dir, { file: 'node', args: [], env: {} });
  assert.equal(pane, 'pid:5150');
  appendFileSync(join(dir, 'unsnooze-resumed.log'),
    '[launcher] headless: launching codex with no pane\nunsnooze: failed to launch codex: spawn codex ENOENT\n');
  spawner.exit(127);

  const outcome = await mux.paneOutcome(pane);
  assert.equal(outcome.exited, true);
  assert.equal(outcome.code, 127);
  assert.match(outcome.output, /spawn codex ENOENT/);
  assert.doesNotMatch(outcome.output, /older revival/, 'output is this child\'s slice of the shared log');
  assert.ok(existsSync(join(dir, 'exits', '5150.json')), 'the exit survives the resumer that saw it');
});

test('paneOutcome is exited:false while the child runs and null when nothing was recorded', async () => {
  const dir = scratch();
  const spawner = scriptedSpawner(6160);
  let running = true;
  const mux = createHeadless({ spawner, alive: pid => pid === 6160 && running, logDir: dir, env: {} });
  const { pane } = await mux.newWindow('unsnooze-resumed', dir, { file: 'node', args: [], env: {} });
  assert.deepEqual(await mux.paneOutcome(pane), { exited: false });
  running = false;                       // gone, but no exit event reached us
  assert.equal(await mux.paneOutcome(pane), null);
  assert.equal(await mux.paneOutcome('nonsense'), null);
});

test('a spawn error and a signal are recorded as failures, and exit 0 as success', async () => {
  const dir = scratch();
  const mux = createHeadless({ spawner: scriptedSpawner(1), alive: () => false, logDir: dir, env: {} });
  const spawners = [scriptedSpawner(7001), scriptedSpawner(7002), scriptedSpawner(7003)];
  const muxes = spawners.map(spawner => createHeadless({ spawner, alive: () => false, logDir: dir, env: {} }));
  const panes = [];
  for (const m of muxes) panes.push((await m.newWindow('s', dir, { file: 'node', args: [], env: {} })).pane);
  spawners[0].error(new Error('spawn node ENOENT'));
  spawners[1].exit(null, 'SIGTERM');
  spawners[2].exit(0);
  const [errored, killed, clean] = await Promise.all(panes.map(p => mux.paneOutcome(p)));
  assert.equal(errored.exited, true); assert.equal(errored.code, null); assert.match(errored.error, /ENOENT/);
  assert.equal(killed.exited, true); assert.equal(killed.signal, 'SIGTERM');
  assert.equal(clean.exited, true); assert.equal(clean.code, 0);
});

test('a recycled pid does not inherit the previous process\'s exit', async () => {
  const dir = scratch();
  const first = scriptedSpawner(8080);
  const muxA = createHeadless({ spawner: first, alive: () => false, logDir: dir, env: {} });
  const { pane } = await muxA.newWindow('s', dir, { file: 'node', args: [], env: {} });
  first.exit(127);
  assert.equal((await muxA.paneOutcome(pane)).code, 127);

  const second = scriptedSpawner(8080);
  let running = true;
  const muxB = createHeadless({ spawner: second, alive: () => running, logDir: dir, env: {} });
  await muxB.newWindow('s', dir, { file: 'node', args: [], env: {} });
  assert.deepEqual(await muxB.paneOutcome(pane), { exited: false });
  running = false;
  assert.equal(await muxB.paneOutcome(pane), null, 'the old 127 must be gone');
});

// Staggered revivals share one log: the resumer launches the next one 8s after
// the last and verifies 20s later, so a revival that died at once is read back
// after the next has written its own lines. Those lines are not its reason.
test('a revival launched after another died is not blamed for its death', async () => {
  const dir = scratch();
  const log = join(dir, 'unsnooze-resumed.log');
  const dead = scriptedSpawner(9001);
  const muxA = createHeadless({ spawner: dead, alive: () => false, logDir: dir, env: {} });
  const { pane } = await muxA.newWindow('unsnooze-resumed', dir, { file: 'node', args: [], env: {} });
  appendFileSync(log, 'unsnooze: failed to launch codex: spawn codex ENOENT\n');
  dead.exit(127);

  const next = scriptedSpawner(9002);
  const muxB = createHeadless({ spawner: next, alive: () => true, logDir: dir, env: {} });
  await muxB.newWindow('unsnooze-resumed', dir, { file: 'node', args: [], env: {} });
  appendFileSync(log, 'next revival: working on the task\n');

  const outcome = await muxA.paneOutcome(pane);
  assert.equal(outcome.code, 127);
  assert.match(outcome.output, /spawn codex ENOENT/);
  assert.doesNotMatch(outcome.output, /next revival/);
});

// The daemon is long-lived; a log descriptor kept per revival is a leak.
test('newWindow does not keep the log descriptor open in the parent', async () => {
  const { fstatSync } = await import('node:fs');
  const dir = scratch();
  let fd;
  const spawner = (file, args, options) => { fd = options.stdio[1]; return { pid: 9100, unref() {}, on() {} }; };
  const mux = createHeadless({ spawner, alive: () => true, logDir: dir, env: {} });
  await mux.newWindow('s', dir, { file: 'node', args: [], env: {} });
  assert.ok(Number.isInteger(fd));
  assert.throws(() => fstatSync(fd), { code: 'EBADF' });
});

// A spawn that fails (the session's cwd was a worktree that has since been
// removed) reports it as an 'error' event after spawn() returns. Nobody used to
// be listening yet, and an unheard 'error' is an uncaught exception — the
// whole daemon went down with the one revival.
test('a spawn that fails rejects with the reason instead of crashing the process', async () => {
  const dir = scratch();
  const mux = createHeadless({ logDir: dir, env: {} });
  const err = await mux.newWindow('s', join(dir, 'deleted-worktree'), { file: process.execPath, args: ['-e', ''], env: {} })
    .then(() => null, e => e);
  assert.ok(err, 'a launch that cannot happen must reject');
  assert.match(err.message, /produced no pid/);
  if (process.platform !== 'win32') assert.match(err.message, /ENOENT/, 'and say why');
  // Give any stray 'error' a turn of the loop to surface as an uncaught exception.
  await new Promise(resolve => setTimeout(resolve, 50));
});

// The hook-spawned resumer runs in claude's environment, UNSNOOZE_ACTIVE=1
// included — the launcher's "nested call, pass straight through" marker. A
// revival is a fresh launch and must not carry it.
test('a revival does not inherit the nested-launch marker', async () => {
  const dir = scratch();
  let env;
  const spawner = (file, args, options) => { env = options.env; return { pid: 9200, unref() {}, on() {} }; };
  const mux = createHeadless({ spawner, alive: () => true, logDir: dir, env: { UNSNOOZE_ACTIVE: '1', PATH: '/usr/bin' } });
  await mux.newWindow('s', dir, { file: 'node', args: [], env: { UNSNOOZE_MUX: 'headless' } });
  assert.equal(env.UNSNOOZE_ACTIVE, undefined);
  assert.equal(env.UNSNOOZE_MUX, 'headless');
  assert.equal(env.PATH, '/usr/bin');
});

// Windows hands pids out again quickly. Once our child's exit is on record,
// another process now holding the pid must not read as our revival running.
test('a recorded exit wins over a pid that has been reused since', async () => {
  const dir = scratch();
  const spawner = scriptedSpawner(9300);
  const mux = createHeadless({ spawner, alive: () => true, logDir: dir, env: {} });
  const { pane } = await mux.newWindow('s', dir, { file: 'node', args: [], env: {} });
  assert.deepEqual(await mux.paneOutcome(pane), { exited: false });
  spawner.exit(127);
  const outcome = await mux.paneOutcome(pane);
  assert.equal(outcome.exited, true);
  assert.equal(outcome.code, 127);
});
