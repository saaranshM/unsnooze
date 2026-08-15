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

// Driven through the real bin, with a `ps` shim that fails so processBirth()
// returns null exactly as it does on Windows. Unix-only because it depends on
// PATH/sh shim semantics.
const launchTest = process.platform === 'win32'
  ? (name, fn) => test(name, { skip: 'unix-only surface (sh/PATH shims)' }, fn)
  : test;

launchTest('the launcher writes a lease even when the process birth time is unavailable', () => {
  const state = join(DIR, 'launch-state');
  const shims = join(DIR, 'shims');
  mkdirSync(shims, { recursive: true });
  // tmux: alive enough to resolve a pane, and paneAlive answers "gone" (empty
  // stdout) so the detached monitor this launch spawns exits immediately.
  writeFileSync(join(shims, 'tmux'), '#!/bin/sh\ncase "$1" in -V) echo "tmux 3.7b";; esac\nexit 0\n');
  chmodSync(join(shims, 'tmux'), 0o755);
  // ps failing is how a darwin host loses birth times; Windows never has them.
  writeFileSync(join(shims, 'ps'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(shims, 'ps'), 0o755);

  // The launcher removes the lease the moment the agent exits, so polling from
  // out here is a race. The agent shim records what it sees instead: it is the
  // only thing guaranteed to be alive at the same time as the lease.
  const seen = join(DIR, 'lease-seen.json');
  const agent = join(shims, 'slow-agent');
  writeFileSync(agent, `#!/bin/sh\nsleep 1\ncat "${state}"/leases/*.json > "${seen}" 2>/dev/null\n`);
  chmodSync(agent, 0o755);

  const r = spawnSync(process.execPath, [REAL_BIN, '_run', 'claude'], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${shims}:/usr/bin:/bin`,
      UNSNOOZE_STATE_DIR: state,
      UNSNOOZE_CLAUDE_BIN: agent,
      UNSNOOZE_MULTIPLEXER: 'tmux',
      TMUX: '/tmp/fake,1,0', TMUX_PANE: '%14',
      ZELLIJ: '', UNSNOOZE_ACTIVE: '', UNSNOOZE_NOTIFICATIONS: 'off',
    },
  });
  assert.equal(r.status, 0, `launch must succeed: ${r.stderr}`);

  const lease = JSON.parse(readFileSync(seen, 'utf-8'));
  assert.equal(lease.pidBirth, null, 'this host genuinely has no birth time (ps shim fails)');
  assert.equal(lease.agent, 'claude', 'the lease belongs to the launched agent');
  assert.ok(lease.pane, 'the lease carries the pane it watches');
  assert.ok(lease.leaseId, 'the lease carries its id');
});
