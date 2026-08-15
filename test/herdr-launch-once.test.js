// One `unsnooze claude` must never produce two agents.
//
// The launcher answers a failed wrap by running the agent unwatched, which is
// right when the session never started and wrong once the multiplexer has
// already been told to run it: herdr can accept `pane run` (agent starts) and
// then fail to attach a client, and the fallback would start a second agent in
// the user's terminal — two live sessions editing the same repo.
//
// Driven through the real bin with a herdr shim, because the thing under test
// is the launcher's response to the driver, not the driver alone.

import { test as baseTest, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const test = process.platform === 'win32'
  ? (name, fn) => baseTest(name, { skip: 'unix-only surface (sh/PATH shims)' }, fn)
  : baseTest;

const REAL_BIN = fileURLToPath(new URL('../bin/unsnooze.js', import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-launch-once-'));
const SHIMS = join(DIR, 'shims');
mkdirSync(SHIMS);
const RUNS = join(DIR, 'agent-runs');

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

// Records every invocation, so "how many agents did one launch produce" is a
// line count rather than an inference.
function installAgentShim() {
  const agent = join(SHIMS, 'fake-agent');
  writeFileSync(agent, `#!/bin/sh\necho run >> "${RUNS}"\n`);
  chmodSync(agent, 0o755);
  return agent;
}

// A herdr that starts the session and runs the pane command happily, then
// fails at `session attach` — the exact post-dispatch failure.
function installHerdrShim({ attachExit = 1 } = {}) {
  const shim = join(SHIMS, 'herdr');
  const marker = join(DIR, 'server-started');
  // Stateful: the session only exists once `server` has been asked for, which
  // is what makes the driver's start-and-poll loop terminate the way it does
  // against a real herdr.
  writeFileSync(shim, `#!/bin/sh
case "$*" in
  "--version") echo "herdr 0.8.0"; exit 0 ;;
  *"session list --json"*)
    if [ -f "${marker}" ]; then
      printf '%s' '{"sessions":[{"name":"unsnooze","running":true,"socket_path":"/tmp/s.sock"}]}'
    else
      printf '%s' '{"sessions":[]}'
    fi
    exit 0 ;;
  *server*) touch "${marker}"; exit 0 ;;
  *"workspace create"*) printf '%s' '{"result":{"root_pane":{"pane_id":"w1:p1"}}}'; exit 0 ;;
  *"pane run"*) exit 0 ;;
  *"session attach"*) echo "attach failed" >&2; exit ${attachExit} ;;
esac
exit 0
`);
  chmodSync(shim, 0o755);
  rmSync(marker, { force: true });
}

test('an attach failure after the agent was dispatched does not start a second agent', () => {
  const agent = installAgentShim();
  installHerdrShim();
  rmSync(RUNS, { force: true });

  const r = spawnSync(process.execPath, [REAL_BIN, '_run', 'claude'], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${SHIMS}:/usr/bin:/bin`,
      UNSNOOZE_STATE_DIR: join(DIR, 'state'),
      UNSNOOZE_CLAUDE_BIN: agent,
      UNSNOOZE_MULTIPLEXER: 'herdr',
      UNSNOOZE_NOTIFICATIONS: 'off',
      TMUX: '', ZELLIJ: '', HERDR_ENV: '', HERDR_PANE_ID: '', UNSNOOZE_ACTIVE: '',
    },
  });

  // The shim's `pane run` "started" the agent inside the session; our side of
  // the fence must not run it again out here. A non-zero attach exit is the
  // SESSION's exit status (that is what attaching returns), so it propagates
  // quietly — what matters is that no second agent appears.
  const runs = existsSync(RUNS) ? readFileSync(RUNS, 'utf-8').trim().split('\n').filter(Boolean).length : 0;
  assert.equal(runs, 0, `the agent must not be launched a second time (ran ${runs} times)`);
  assert.equal(r.status, 1, 'the session exit status is passed through');
  assert.doesNotMatch(r.stderr, /without limit-watch/, 'this is not the degrade-to-unwatched path');
});

test('herdr vanishing after dispatch names the session instead of relaunching', () => {
  const agent = installAgentShim();
  installHerdrShim();
  // The shim deletes itself once the agent has been dispatched, so `session
  // attach` fails to spawn at all — the same shape as herdr being upgraded or
  // removed mid-launch, and the one case that is unambiguously not a session
  // exit status.
  const shim = join(SHIMS, 'herdr');
  const marker = join(DIR, 'server-started');
  writeFileSync(shim, `#!/bin/sh
case "$*" in
  "--version") echo "herdr 0.8.0"; exit 0 ;;
  *"session list --json"*)
    if [ -f "${marker}" ]; then
      printf '%s' '{"sessions":[{"name":"unsnooze","running":true,"socket_path":"/tmp/s.sock"}]}'
    else
      printf '%s' '{"sessions":[]}'
    fi
    exit 0 ;;
  *server*) touch "${marker}"; exit 0 ;;
  *"workspace create"*) printf '%s' '{"result":{"root_pane":{"pane_id":"w1:p1"}}}'; exit 0 ;;
  *"pane run"*) rm -f "$0"; exit 0 ;;
esac
exit 0
`);
  chmodSync(shim, 0o755);
  rmSync(marker, { force: true });
  rmSync(RUNS, { force: true });

  const r = spawnSync(process.execPath, [REAL_BIN, '_run', 'claude'], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${SHIMS}:/usr/bin:/bin`,
      UNSNOOZE_STATE_DIR: join(DIR, 'state3'),
      UNSNOOZE_CLAUDE_BIN: agent,
      UNSNOOZE_MULTIPLEXER: 'herdr',
      UNSNOOZE_NOTIFICATIONS: 'off',
      TMUX: '', ZELLIJ: '', HERDR_ENV: '', HERDR_PANE_ID: '', UNSNOOZE_ACTIVE: '',
    },
  });

  const runs = existsSync(RUNS) ? readFileSync(RUNS, 'utf-8').trim().split('\n').filter(Boolean).length : 0;
  assert.equal(runs, 0, `no second agent (ran ${runs} times)`);
  assert.match(r.stderr, /may already be running/, 'the user is told the agent exists');
  assert.match(r.stderr, /herdr session attach unsnooze/, 'and how to reach it');
  assert.doesNotMatch(r.stderr, /without limit-watch/);
});

test('a failure BEFORE dispatch still degrades to a normal unwatched run', () => {
  const agent = installAgentShim();
  // A herdr that cannot create the workspace: nothing was ever dispatched.
  writeFileSync(join(SHIMS, 'herdr'), `#!/bin/sh
case "$*" in
  "--version") echo "herdr 0.8.0"; exit 0 ;;
  *"session list --json"*) printf '%s' '{"sessions":[{"name":"unsnooze","running":true,"socket_path":"/tmp/s.sock"}]}'; exit 0 ;;
  *"workspace create"*) echo "no workspace for you" >&2; exit 1 ;;
esac
exit 0
`);
  chmodSync(join(SHIMS, 'herdr'), 0o755);
  rmSync(RUNS, { force: true });

  const r = spawnSync(process.execPath, [REAL_BIN, '_run', 'claude'], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${SHIMS}:/usr/bin:/bin`,
      UNSNOOZE_STATE_DIR: join(DIR, 'state2'),
      UNSNOOZE_CLAUDE_BIN: agent,
      UNSNOOZE_MULTIPLEXER: 'herdr',
      UNSNOOZE_NOTIFICATIONS: 'off',
      TMUX: '', ZELLIJ: '', HERDR_ENV: '', HERDR_PANE_ID: '', UNSNOOZE_ACTIVE: '',
    },
  });

  const runs = existsSync(RUNS) ? readFileSync(RUNS, 'utf-8').trim().split('\n').filter(Boolean).length : 0;
  assert.equal(runs, 1, 'the user still gets their agent when nothing was dispatched');
  assert.match(r.stderr, /without limit-watch/);
});

test('a detached spawn of a missing herdr binary reports an error instead of killing the process', () => {
  // Node reports async spawn failures by emitting 'error'; with no listener
  // that is an uncaught exception, and this path runs inside the resumer
  // daemon. The assertion is that the process survives to print its own error.
  const script = `
    import { createHerdr } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/multiplexers/herdr.js')).href)};
    const mux = createHerdr({ env: {} });
    try {
      await mux.ensureSessionRunning('nope');
      console.log('NO_THROW');
    } catch (err) {
      console.log('CAUGHT:' + err.name);
    }
    console.log('STILL_ALIVE');
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: '/nonexistent' },
    cwd: process.cwd(),
  });
  assert.match(r.stdout, /CAUGHT:SessionCreateError/, `expected a typed error, got: ${r.stdout} ${r.stderr}`);
  assert.match(r.stdout, /STILL_ALIVE/, 'the process must survive an ENOENT');
  assert.equal(r.status, 0, 'and exit normally');
});
