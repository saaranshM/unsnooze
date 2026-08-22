#!/usr/bin/env node
// Live verification of the herdr backend against a real herdr (>= 0.8.0).
//
// This drives src/multiplexers/herdr.js — the module that ships — rather than
// the herdr CLI directly. That distinction is the whole point: the unit suite
// fakes the spawner, so it can only prove we emit the arguments we meant to
// emit. Everything that actually broke on this backend lived on the other
// side of that boundary, in what herdr does with those arguments.
//
// Safe to run on a machine with real herdr sessions: it uses its own config
// root and a session name unique to this process, scrubs every ambient
// HERDR_*/UNSNOOZE_* variable, and deletes what it created.
//
//   node scripts/e2e-herdr.mjs [--keep]
//
// Not run by CI (CI has no herdr). Run it before releasing a herdr change.

import { mkdtempSync, rmSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import { createHerdr } from '../src/multiplexers/herdr.js';

const KEEP = process.argv.includes('--keep');
const SESSION = `unsnooze-e2e-${process.pid}`;
// Short path on purpose: a unix socket path is capped at ~104 bytes, and
// herdr nests its session sockets a few directories deep.
const CFG = mkdtempSync('/tmp/use2e');

const ENV = { ...process.env, XDG_CONFIG_HOME: CFG };
for (const key of Object.keys(ENV)) {
  if (key.startsWith('HERDR') || key.startsWith('UNSNOOZE')) delete ENV[key];
}

const mux = createHerdr({ env: ENV });
const sess = mux.bind(SESSION);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failures = 0;
let created = false;
const pass = msg => console.log(`  ok   ${msg}`);
const fail = (msg, detail) => { failures += 1; console.log(`  FAIL ${msg}${detail ? `\n       ${detail}` : ''}`); };
const check = (cond, msg, detail) => (cond ? pass(msg) : fail(msg, detail));
const section = msg => console.log(`\n${msg}`);

// Panes are narrow (herdr wraps at the viewport, ~52 columns here), and a
// wrapped line is not the line the program printed. `recent-unwrapped` is the
// only read that can be parsed; the shipped driver deliberately does not expose
// it, so the harness asks herdr directly.
async function readUnwrapped(pane) {
  const { stdout } = await execFileAsync('herdr', ['--session', SESSION, 'pane', 'read', pane,
    '--source', 'recent-unwrapped', '--lines', '200', '--format', 'text'], { env: ENV });
  return stdout;
}

// A sentinel printed LAST, so waiting cannot be satisfied by the shell echoing
// the command back — which contains every string we are looking for.
const DONE = '__UNSNOOZE_E2E_DONE__';

// The sentinel appears inside the echoed command line too (a pane echoes what
// was typed, and herdr's typed line is echoed again once the prompt draws), so
// only a line that is NOTHING BUT the sentinel is real output.
const outputLines = text => text.split('\n').filter(line => line.trim() === DONE).length;

async function waitForDone(pane, { tries = 40, delay = 250 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const text = await readUnwrapped(pane).catch(() => '');
    if (outputLines(text) >= 1) return text;
    await sleep(delay);
  }
  return null;
}

async function main() {
  section('version floor');
  check(mux.available(), 'available() accepts the installed herdr',
    'needs herdr >= 0.8.0 on PATH — brew ships 0.7.3, use the release binary');
  if (!mux.available()) return;

  section('session lifecycle');
  const server = spawn('herdr', ['--session', SESSION, 'server'], { env: ENV, detached: true, stdio: 'ignore' });
  server.unref();
  created = true;
  for (let i = 0; i < 60 && !(await mux.listSessions()).some(s => s.name === SESSION && !s.exited); i += 1) {
    await sleep(200);
  }
  check((await mux.listSessions()).some(s => s.name === SESSION && !s.exited), 'the session is running');

  section('argv fidelity through pane run (the bug this backend shipped with)');
  const NASTY = ['a b', "it's", '', '$(id)', '`id`', 'a;b|c', '*', '--flag=va lue', 'ü', 'back\\slash'];
  const address = await sess.newWindow(SESSION, '/tmp', {
    file: process.execPath,
    args: ['-e', `for (const a of process.argv.slice(1)) console.log("ARG:" + JSON.stringify(a)); console.log("${DONE}")`, ...NASTY],
    env: { UNSNOOZE_MUX: 'herdr', CLAUDE_CONFIG_DIR: '/tmp/cfg', SHOULD_NOT_PASS: 'x' },
  });
  const out = await waitForDone(address.pane);
  const got = (out || '').split('\n').filter(l => l.startsWith('ARG:')).map(l => {
    try { return JSON.parse(l.slice(4)); } catch { return null; }
  });
  check(got.length === NASTY.length, `all ${NASTY.length} arguments arrived (got ${got.length})`);
  NASTY.forEach((want, i) => check(got[i] === want,
    `argument ${i} survives quoting: ${JSON.stringify(want)}`, `got ${JSON.stringify(got[i])}`));

  section('a message that cannot be typed still reaches the agent');
  // Newlines and tabs are keystrokes to a terminal, so this argument is carried
  // in the workspace environment and referenced by the typed line instead.
  const MULTILINE = 'first line\nsecond line\tafter a tab\nthird line';
  const hoisted = await sess.newWindow(SESSION, '/tmp', {
    file: process.execPath,
    args: ['-e', `console.log("MSG:" + JSON.stringify(process.argv[1])); console.log("${DONE}")`, MULTILINE],
    env: {},
  });
  const hoistedOut = await waitForDone(hoisted.pane);
  const msgLine = (hoistedOut || '').split('\n').find(l => l.startsWith('MSG:'));
  let delivered = null;
  try { delivered = JSON.parse((msgLine || '').slice(4)); } catch { /* reported below */ }
  check(delivered === MULTILINE, 'a multi-line, tab-bearing argument arrives byte for byte',
    `got ${JSON.stringify(delivered)}`);

  section('one submission, not two');
  // The command line is echoed once and its output printed once. A second
  // Enter (the bug this backend shipped with) shows up as a repeated run.
  const screen = await readUnwrapped(address.pane);
  const ran = outputLines(screen);
  check(ran === 1, 'the command ran exactly once',
    `the sentinel was printed ${ran} times — a second Enter would run it again`);
  const argLines = (screen.match(/^ARG:/gm) || []).length;
  check(argLines === NASTY.length, `exactly ${NASTY.length} argument lines, not a doubled run`,
    `saw ${argLines}`);

  section('one workspace per project (#15)');
  // A herdr workspace is the project, not the window — it is per repo, the way
  // a tmux SESSION is. Both revivals above ran in /tmp, so the second must have
  // opened a TAB inside the first one's workspace rather than a second
  // top-level workspace for the same work. Pane ids are workspace-qualified
  // (`w2:p7`), so the prefix is the answer.
  const workspaceOf = pane => String(pane).split(':')[0];
  check(workspaceOf(hoisted.pane) === workspaceOf(address.pane),
    'a second revival in the same directory reuses that project workspace',
    `${hoisted.pane} vs ${address.pane}`);
  const elsewhere = await sess.newWindow(SESSION, CFG, {
    file: '/bin/sh', args: ['-c', `echo ${DONE}`], env: {},
  });
  await waitForDone(elsewhere.pane);
  check(workspaceOf(elsewhere.pane) !== workspaceOf(address.pane),
    'a revival in a directory herdr has nothing open on still gets its own workspace',
    `${elsewhere.pane} vs ${address.pane}`);

  section('capture sources');
  const detection = await sess.capturePane(address.pane, 200);
  check(typeof detection === 'string' && detection.length > 0, 'capturePane (detection) returns the live screen');
  const scrollback = await sess.captureScrollback(address.pane, 200);
  check(scrollback.split('\n').length >= detection.split('\n').length,
    'captureScrollback returns at least as much as the live screen',
    `${scrollback.split('\n').length} vs ${detection.split('\n').length} lines`);

  section('launch environment');
  const envOut = await sess.newWindow(SESSION, '/tmp', {
    file: '/bin/sh',
    // The sentinel goes on its own line so waitForDone can tell output from
    // the echoed command.
    args: ['-c', `echo "MUX=$UNSNOOZE_MUX CFG=$CLAUDE_CONFIG_DIR LEAK=$SHOULD_NOT_PASS"; echo ${DONE}`],
    env: { UNSNOOZE_MUX: 'herdr', CLAUDE_CONFIG_DIR: '/tmp/cfg', SHOULD_NOT_PASS: 'leaked' },
  });
  const envText = await waitForDone(envOut.pane);
  const printed = (envText || '').split('\n').filter(l => l.trimStart().startsWith('MUX=')).join('\n');
  check(/MUX=herdr/.test(printed), 'UNSNOOZE_* reaches the pane', printed);
  check(/CFG=\/tmp\/cfg/.test(printed), 'the Claude config root reaches the pane', printed);
  check(!/LEAK=leaked/.test(printed), 'unrelated environment does not', printed);

  section('pane ownership stamp');
  // The identity every later inject/close decision verifies against. Without
  // it herdr would fall back to comparing process start times, which do not
  // exist on every host.
  await sess.stampPaneOwner(address.pane, 'lease-e2e-1');
  check(await sess.paneOwnerStamp(address.pane) === 'lease-e2e-1', 'a pane stamp round-trips');
  await sess.stampPaneOwner(address.pane, 'lease-e2e-2');
  check(await sess.paneOwnerStamp(address.pane) === 'lease-e2e-2', 'and a relaunch overwrites it');
  check(await sess.paneOwnerStamp('w99:p99') === null, 'a pane that does not exist has no stamp');

  section('pane queries');
  check(await sess.paneAlive(address.pane), 'paneAlive is true for a live pane');
  check(!(await sess.paneAlive('w99:p99')), 'paneAlive is false for a pane that does not exist');
  const panes = await sess.listSessionPanes(SESSION);
  check(panes.includes(address.pane), 'listSessionPanes includes the pane we created');

  section('stopped sessions are taken, not free');
  await sess.closePane(address.pane).catch(() => {});
  // Stop it the way a user would, then confirm the name is still occupied.
  await new Promise(resolve => {
    const stop = spawn('herdr', ['session', 'stop', SESSION], { env: ENV, stdio: 'ignore' });
    stop.on('exit', resolve); stop.on('error', resolve);
  });
  await sleep(500);
  const rows = await mux.listSessions();
  check(rows.some(s => s.name === SESSION), 'a stopped session is still listed (so its name is taken)');
  check(rows.some(s => s.name === SESSION && s.exited), 'and is reported as exited');
  let refused = false;
  try { await mux.ensureSessionRunning(SESSION); } catch (err) { refused = err.name === 'SessionCreateError'; }
  check(refused, 'ensureSessionRunning refuses to restart it (herdr would restore its agents)');
}

try {
  await main();
} catch (err) {
  fail('harness threw', err.stack || err.message);
} finally {
  if (created && !KEEP) {
    for (const args of [['session', 'stop', SESSION], ['session', 'delete', SESSION]]) {
      await new Promise(resolve => {
        const p = spawn('herdr', args, { env: ENV, stdio: 'ignore' });
        p.on('exit', resolve); p.on('error', resolve);
      });
    }
  }
  if (!KEEP) rmSync(CFG, { recursive: true, force: true });
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}
