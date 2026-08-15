// A monitor whose agent never launched must not scrape the pane forever.
//
// runLauncher() spawns the monitor BEFORE it spawns the agent, then writes the
// agent's lease. If the agent never starts — a bad `bin` path, an immediate
// crash — no lease is ever written, so the lease-gone exit (which only arms
// after the lease has been seen once) can never fire. The pane itself stays
// alive, because in the user's own session the pane is their shell. The result
// is a monitor scraping a shell prompt until the machine reboots, one more per
// failed launch.
//
// The other half of the same bug: the lease used to be written only when
// processBirth() returned a value. It reads /proc on linux and `ps` on darwin
// and returns null everywhere else, so on Windows a HEALTHY agent produced no
// lease either — which makes "no lease yet" fatally ambiguous unless the write
// is unconditional. Both halves are pinned here.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REAL_BIN = fileURLToPath(new URL('../bin/unsnooze.js', import.meta.url));

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-monitor-lease-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');

// The launch fixture has to exist before the imports below: src/agents/claude.js
// reads UNSNOOZE_CLAUDE_BIN at module-eval time, so setting it inside the test
// would be too late and the launcher would try to spawn the real `claude`.
const SHIMS = join(DIR, 'shims');
const LEASE_SEEN = join(DIR, 'lease-seen.json');
const AGENT_SHIM = join(SHIMS, 'slow-agent');
if (process.platform !== 'win32') {
  mkdirSync(SHIMS, { recursive: true });
  // tmux: alive enough to resolve a pane, and paneAlive answers "gone" (empty
  // stdout) so the detached monitor this launch spawns exits immediately.
  writeFileSync(join(SHIMS, 'tmux'), '#!/bin/sh\ncase "$1" in -V) echo "tmux 3.7b";; esac\nexit 0\n');
  chmodSync(join(SHIMS, 'tmux'), 0o755);
  // The launcher removes the lease the moment the agent exits, so reading it
  // from the test is a race. The agent records what it sees instead: it is the
  // only thing guaranteed to be alive at the same time as the lease.
  writeFileSync(AGENT_SHIM, `#!/bin/sh\nsleep 1\ncat "${join(DIR, 'leases')}"/*.json > "${LEASE_SEEN}" 2>/dev/null\n`);
  chmodSync(AGENT_SHIM, 0o755);
  process.env.UNSNOOZE_CLAUDE_BIN = AGENT_SHIM;
}

const { createMonitor } = await import('../src/monitor.js');
const { writeLease, readLease } = await import('../src/lease.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

function fakeMux(script = {}) {
  return {
    paneAlive: async () => script.alive ?? true,     // the user's shell outlives the agent
    capturePane: async () => script.text ?? '> idle',
    capturePaneVisible: async () => script.text ?? '> idle',
    sendText: async () => {},
    sendKey: async () => {},
    sessionForPane: async () => '0',
  };
}

function build({ pane, leaseId = 'lease-1', leaseGraceMs, startedAt, script = {} } = {}) {
  return createMonitor({
    muxName: 'tmux', paneOwner: null, pane, leaseId, cwd: '/tmp',
    mux: fakeMux(script), spawner: () => process.pid, versionSkewed: () => false,
    scrapeInterval: 0, leaseGraceMs, startedAt,
  });
}

test('a lease that never appears stops the monitor once the grace elapses', async () => {
  // startedAt in the past is the honest way to model "the grace has elapsed"
  // without sleeping for it.
  const monitor = build({ pane: '%10', leaseGraceMs: 1_000, startedAt: Date.now() - 5_000 });
  await monitor.run();
  // run() returning at all is the assertion: with the bug this loop never ends.
  assert.equal(readLease({ mux: 'tmux', paneOwner: null, pane: '%10' }, 'lease-1'), null);
});

test('a lease that arrives inside the grace keeps the monitor running', async () => {
  const pane = '%11';
  writeLease({ leaseId: 'lease-1', mux: 'tmux', paneOwner: null, pane, pid: process.pid });
  // Pane death is the only thing that should end this run — not the grace.
  const monitor = build({ pane, leaseGraceMs: 1_000, startedAt: Date.now() - 5_000, script: { alive: false } });
  await monitor.run();
  assert.ok(readLease({ mux: 'tmux', paneOwner: null, pane }, 'lease-1'), 'lease still present');
});

test('the grace does not fire while it is still running', async () => {
  const monitor = build({ pane: '%12', leaseGraceMs: 60_000, startedAt: Date.now(), script: { alive: false } });
  await monitor.run();   // exits via pane death; the point is it did not exit via the grace
  const logged = readdirSync(DIR);
  assert.ok(logged.includes('unsnooze.log'));
});

test('no leaseId at all: the grace is not armed (nothing to wait for)', async () => {
  const monitor = build({ pane: '%13', leaseId: null, leaseGraceMs: 1, startedAt: Date.now() - 5_000, script: { alive: false } });
  await monitor.run();
  assert.ok(true, 'a monitor with no lease to watch exits on pane death as before');
});

// Unix-only: it drives sh shims and PATH semantics. Run in-process rather than
// through the bin, because "this host cannot report a birth time" has no single
// external cause to fake — darwin loses it when `ps` fails, linux reads
// /proc/<pid>/stat instead, and Windows has neither. Shimming `ps` only
// reproduces it on darwin, which is how the first version of this test passed
// locally and failed on ubuntu. The seam is the honest way to say it.
const launchTest = process.platform === 'win32'
  ? (name, fn) => test(name, { skip: 'unix-only surface (sh/PATH shims)' }, fn)
  : test;

launchTest('the launcher writes a lease even when the process birth time is unavailable', async () => {
  // Earlier tests in this file wrote leases into the same directory; the shim
  // reads every one it finds, so start from an empty one.
  rmSync(join(DIR, 'leases'), { recursive: true, force: true });
  const { runLauncher } = await import('../src/launcher.js');
  const saved = { ...process.env };
  Object.assign(process.env, {
    PATH: `${SHIMS}:/usr/bin:/bin`,
    UNSNOOZE_MULTIPLEXER: 'tmux',
    TMUX: '/tmp/fake,1,0',
    TMUX_PANE: '%14',
    ZELLIJ: '', UNSNOOZE_ACTIVE: '',
  });
  try {
    // processBirthFn is the seam runLauncher exposes precisely so this case is
    // reachable on every platform.
    const status = await runLauncher([], 'claude', { processBirthFn: () => null });
    assert.equal(status, 0, 'the agent still runs');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }

  const lease = JSON.parse(readFileSync(LEASE_SEEN, 'utf-8'));
  assert.equal(lease.pidBirth, null, 'a lease is written even with no birth time to record');
  assert.equal(lease.agent, 'claude', 'the lease belongs to the launched agent');
  assert.ok(lease.pane, 'the lease carries the pane it watches');
  assert.ok(lease.leaseId, 'the lease carries its id');
});
