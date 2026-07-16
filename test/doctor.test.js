// F3 — `unsnooze doctor`: detect leftovers of the pre-release csg
// (claude-session-guard) install and verify the current install's health.
// The 2026-07-15 incident forensics: zombie csg _monitor processes driving
// menus on the shared tmux socket, an orphaned csg state dir, the old global
// package + `csg` symlink — none of which install/uninstall ever touched.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-doctor-'));
process.env.UNSNOOZE_STATE_DIR = join(DIR, 'state');

const {
  findCsgProcesses, findCsgAutostarts, defaultCsgPackagePath, runDoctor, applyFixes, cmdDoctor,
} = await import('../src/doctor.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

// --- detection -----------------------------------------------------------------

test('findCsgProcesses picks csg.js processes out of ps output, never unsnooze ones', () => {
  const ps = [
    '  123 node /Users/u/PersonalProjects/claude-session-guard/bin/csg.js _monitor %0',
    '  456 node /x/lib/node_modules/unsnooze/bin/unsnooze.js daemon',
    '  789 node /Users/u/dev/claude-session-guard/bin/csg.js _resumer',
    '  999 vim csg.js.md',
  ].join('\n');
  const procs = findCsgProcesses({ runner: () => ({ status: 0, stdout: ps }) });
  assert.deepEqual(procs.map(p => p.pid), [123, 789]);
  assert.match(procs[0].command, /csg\.js _monitor/);
});

test('findCsgProcesses returns [] when ps fails', () => {
  assert.deepEqual(findCsgProcesses({ runner: () => ({ status: 1, stdout: '' }) }), []);
});

test('findCsgAutostarts flags launchd plists that exec csg, skips the unsnooze one', () => {
  const la = join(DIR, 'LaunchAgents');
  mkdirSync(la, { recursive: true });
  writeFileSync(join(la, 'com.claude-session-guard.daemon.plist'),
    '<plist><string>/x/claude-session-guard/bin/csg.js</string></plist>');
  writeFileSync(join(la, 'com.unsnooze.daemon.plist'),
    '<plist><string>/x/unsnooze/bin/unsnooze.js</string></plist>');
  writeFileSync(join(la, 'com.other.tool.plist'), '<plist><string>/bin/other</string></plist>');
  const units = findCsgAutostarts({ dir: la });
  assert.deepEqual(units, [join(la, 'com.claude-session-guard.daemon.plist')]);
});

test('runDoctor reports legacy findings for processes, autostarts, and the state dir', async () => {
  const la = join(DIR, 'LaunchAgents2');
  mkdirSync(la, { recursive: true });
  writeFileSync(join(la, 'com.csg.plist'), '<string>csg.js daemon</string>');
  const csgState = join(DIR, 'old-csg-state');
  mkdirSync(csgState, { recursive: true });

  const report = await runDoctor({
    runner: () => ({ status: 0, stdout: '  42 node /x/bin/csg.js _monitor %1' }),
    launchAgentsDir: la,
    csgStateDir: csgState,
    csgBinPath: null,                       // csg not on PATH
    mux: { name: 'tmux', available: () => true },
    hookInstalled: () => true,
    wrappersInstalled: () => true,
  });

  const ids = report.findings.filter(f => f.kind === 'legacy').map(f => f.id);
  assert.ok(ids.includes('csg-processes'), 'zombie csg processes flagged');
  assert.ok(ids.includes('csg-autostart'), 'old launchd unit flagged');
  assert.ok(ids.includes('csg-state-dir'), 'old state dir flagged');
  assert.equal(report.healthy, false);
});

test('runDoctor is all-clear on a clean, fully-installed machine', async () => {
  const report = await runDoctor({
    runner: () => ({ status: 0, stdout: '' }),
    launchAgentsDir: join(DIR, 'no-such-dir'),
    csgStateDir: join(DIR, 'no-such-state'),
    csgBinPath: null,
    mux: { name: 'tmux', available: () => true },
    hookInstalled: () => true,
    wrappersInstalled: () => true,
  });
  assert.equal(report.healthy, true);
  assert.equal(report.findings.filter(f => f.kind === 'legacy').length, 0);
});

test('runDoctor flags missing hook / wrappers / multiplexer as health problems', async () => {
  const report = await runDoctor({
    runner: () => ({ status: 0, stdout: '' }),
    launchAgentsDir: join(DIR, 'nope'),
    csgStateDir: join(DIR, 'nope'),
    csgBinPath: null,
    mux: { name: 'tmux', available: () => false },
    hookInstalled: () => false,
    wrappersInstalled: () => false,
  });
  const ids = report.findings.filter(f => f.kind === 'health').map(f => f.id);
  assert.ok(ids.includes('hook-missing'));
  assert.ok(ids.includes('wrappers-missing'));
  assert.ok(ids.includes('mux-missing'));
  assert.equal(report.healthy, false);
});

// --- fixes ----------------------------------------------------------------------

test('applyFixes kills csg processes, unloads+removes units, archives the state dir', async () => {
  const la = join(DIR, 'LaunchAgents3');
  mkdirSync(la, { recursive: true });
  const unit = join(la, 'com.csg.plist');
  writeFileSync(unit, '<string>csg.js daemon</string>');
  const csgState = join(DIR, 'csg-state-to-archive');
  mkdirSync(csgState, { recursive: true });
  writeFileSync(join(csgState, 'state.json'), '{}');

  const killed = [];
  const ran = [];
  const report = await runDoctor({
    runner: () => ({ status: 0, stdout: '  42 node /x/bin/csg.js _monitor %1' }),
    launchAgentsDir: la,
    csgStateDir: csgState,
    csgBinPath: '/x/bin/csg',
    mux: { name: 'tmux', available: () => true },
    hookInstalled: () => true,
    wrappersInstalled: () => true,
  });

  const actions = await applyFixes(report, {
    kill: pid => killed.push(pid),
    runner: (cmd, args) => { ran.push([cmd, ...args]); return { status: 0 }; },
  });

  assert.deepEqual(killed, [42], 'csg monitor SIGTERMed');
  assert.ok(ran.some(c => c[0] === 'launchctl' && c.includes('unload')), 'unit unloaded');
  assert.ok(!existsSync(unit), 'unit file removed');
  assert.ok(!existsSync(csgState), 'state dir moved away');
  assert.ok(existsSync(`${csgState}.bak`), 'state dir archived, not deleted');
  assert.ok(actions.length >= 3);
  // The npm package is never uninstalled automatically — only hinted.
  assert.ok(!ran.some(c => c[0] === 'npm'), 'npm rm is a hint, never run');
});

// --- CLI ------------------------------------------------------------------------

test('cmdDoctor prints a report and exits 0 when healthy, 1 when not', async () => {
  const lines = [];
  const cleanDeps = {
    runner: () => ({ status: 0, stdout: '' }),
    launchAgentsDir: join(DIR, 'nope'),
    csgStateDir: join(DIR, 'nope'),
    csgBinPath: null,
    mux: { name: 'tmux', available: () => true },
    hookInstalled: () => true,
    wrappersInstalled: () => true,
    print: l => lines.push(l),
  };
  assert.equal(await cmdDoctor([], cleanDeps), 0);
  assert.match(lines.join('\n'), /healthy|all clear/i);

  const dirty = { ...cleanDeps, hookInstalled: () => false, print: l => lines.push(l) };
  assert.equal(await cmdDoctor([], dirty), 1);
});

test('defaultCsgPackagePath finds the package via npm root even as a dangling symlink', () => {
  // Post-rename reality: the repo no longer has bin/csg.js, so the global
  // `csg` bin symlink DANGLES and `command -v csg` misses it. The package
  // entry in node_modules (itself often an npm-link) is the durable signal.
  const root = join(DIR, 'global-node-modules');
  mkdirSync(root, { recursive: true });
  symlinkSync(join(DIR, 'nowhere-repo'), join(root, 'claude-session-guard'));   // dangling
  const found = defaultCsgPackagePath({ runner: () => ({ status: 0, stdout: `${root}\n` }) });
  assert.equal(found, join(root, 'claude-session-guard'));

  const empty = join(DIR, 'global-empty');
  mkdirSync(empty, { recursive: true });
  assert.equal(
    defaultCsgPackagePath({
      runner: () => ({ status: 0, stdout: `${empty}\n` }),
      execPathRoots: [],                     // suppress the real-machine fallback
    }),
    null);
});

test('runDoctor flags the stale csg package when present', async () => {
  const report = await runDoctor({
    runner: () => ({ status: 0, stdout: '' }),
    launchAgentsDir: join(DIR, 'nope'),
    csgStateDir: join(DIR, 'nope'),
    csgBinPath: '/x/lib/node_modules/claude-session-guard',
    mux: { name: 'tmux', available: () => true },
    hookInstalled: () => true,
    wrappersInstalled: () => true,
  });
  const pkg = report.findings.find(f => f.id === 'csg-package');
  assert.ok(pkg, 'package finding present');
  assert.match(pkg.detail, /npm rm -g claude-session-guard/);
  assert.equal(report.healthy, false);
});

test('findCsgAutostarts never flags a unit that execs unsnooze — even from a repo path named claude-session-guard', () => {
  // Dev-checkout reality: the repo folder kept the old name after the rename,
  // so a daemon plist exec'ing .../claude-session-guard/bin/unsnooze.js is the
  // LIVE unsnooze daemon. Flagging it would let --fix destroy the daemon.
  const la = join(DIR, 'LaunchAgents4');
  mkdirSync(la, { recursive: true });
  writeFileSync(join(la, 'com.unsnooze.daemon.plist'),
    '<plist><string>/Users/u/PersonalProjects/claude-session-guard/bin/unsnooze.js</string><string>daemon</string></plist>');
  writeFileSync(join(la, 'com.old.csg.plist'),
    '<plist><string>/Users/u/PersonalProjects/claude-session-guard/bin/csg.js</string><string>daemon</string></plist>');
  const units = findCsgAutostarts({ dir: la });
  assert.deepEqual(units, [join(la, 'com.old.csg.plist')],
    'csg.js unit flagged; unsnooze.js unit untouchable regardless of its path');
});
