// Daemon autostart: launchd plist / systemd user unit generation + install.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import {
  launchdPlist, systemdUnit, installDaemonAutostart, uninstallDaemonAutostart, healDaemonAutostart, DAEMON_LABEL,
  isSupervised, autostartUnitPath, pathResolves, resolveLoginPath,
} from '../src/install.js';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-autostart-test-'));

// Keep autostart writes off the REAL ~/Library/LaunchAgents and systemd user
// dir. install.js provides these overrides for exactly this reason: every unit
// we generate carries one label, so a test that writes or loads the live path
// hijacks the machine's actual daemon (this happened — a doctor --fix test
// repointed the running job at a temp dir and broke its log paths).
process.env.UNSNOOZE_LAUNCH_AGENTS_DIR = join(DIR, 'LaunchAgents-isolated');
process.env.UNSNOOZE_SYSTEMD_USER_DIR = join(DIR, 'systemd-isolated');
after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

test('launchdPlist runs the daemon at load and keeps it alive', () => {
  const xml = launchdPlist({ nodeBin: '/usr/local/bin/node', unsnoozeBin: '/x/unsnooze/bin/unsnooze.js' });
  assert.match(xml, /<string>com\.unsnooze\.daemon<\/string>/);
  assert.match(xml, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(xml, /<string>\/x\/unsnooze\/bin\/unsnooze\.js<\/string>/);
  assert.match(xml, /<string>daemon<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test('launchdPlist escapes XML-special path characters', () => {
  const xml = launchdPlist({ nodeBin: '/odd & path/node', unsnoozeBin: '/x/bin/unsnooze.js' });
  assert.match(xml, /\/odd &amp; path\/node/);
});

test('launchdPlist throttles KeepAlive respawns (upgrade-window crash-loop guard)', () => {
  // Without ThrottleInterval, KeepAlive + a half-installed package =
  // instant-respawn crash-loop (observed: 12,989 MODULE_NOT_FOUND crashes).
  const xml = launchdPlist({ nodeBin: '/usr/local/bin/node', unsnoozeBin: '/x/bin/unsnooze.js' });
  assert.match(xml, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
});

test('systemdUnit execs the daemon and always restarts (clean exits included)', () => {
  const unit = systemdUnit({ nodeBin: '/usr/bin/node', unsnoozeBin: '/x/bin/unsnooze.js' });
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/x\/bin\/unsnooze\.js" daemon/);
  // The version-skew guard and upgrade fail-safe exit 0 EXPECTING a respawn
  // on fresh code — Restart=on-failure would leave the daemon dead on Linux.
  assert.match(unit, /Restart=always/);
  assert.doesNotMatch(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);
});

test('systemdUnit throttles respawns without ever bricking the unit', () => {
  const unit = systemdUnit({ nodeBin: '/usr/bin/node', unsnoozeBin: '/x/bin/unsnooze.js' });
  // RestartSec is the throttle (like launchd ThrottleInterval); the start
  // rate-limit is disabled so a long broken-install window can never trip
  // the unit into a permanent 'failed' state.
  assert.match(unit, /RestartSec=30/);
  assert.match(unit, /StartLimitIntervalSec=0/);
});

test('darwin install writes the plist into the target dir and loads it', () => {
  const calls = [];
  const dir = join(DIR, 'LaunchAgents');
  const path = installDaemonAutostart({ platform: 'darwin', dir, activate: (cmd, args) => calls.push([cmd, ...args]) });
  assert.equal(path, join(dir, `${DAEMON_LABEL}.plist`));
  assert.ok(existsSync(path));
  assert.match(readFileSync(path, 'utf-8'), /<string>daemon<\/string>/);
  assert.ok(calls.some(c => c[0] === 'launchctl' && c.includes('load') || c.includes('bootstrap')));
});

test('linux install writes the systemd user unit and enables it', () => {
  const calls = [];
  const dir = join(DIR, 'systemd-user');
  const path = installDaemonAutostart({ platform: 'linux', dir, activate: (cmd, args) => calls.push([cmd, ...args]) });
  assert.equal(path, join(dir, 'unsnooze.service'));
  assert.ok(existsSync(path));
  assert.ok(calls.some(c => c[0] === 'systemctl' && c.includes('enable')));
});

test('uninstall removes the artifacts again', () => {
  const dir = join(DIR, 'LaunchAgents');
  assert.ok(existsSync(join(dir, `${DAEMON_LABEL}.plist`)));
  const removed = uninstallDaemonAutostart({ platform: 'darwin', dir, activate: () => true });
  assert.equal(removed, join(dir, `${DAEMON_LABEL}.plist`));
  assert.ok(!existsSync(join(dir, `${DAEMON_LABEL}.plist`)));

  const dir2 = join(DIR, 'systemd-user');
  uninstallDaemonAutostart({ platform: 'linux', dir: dir2, activate: () => true });
  assert.ok(!existsSync(join(dir2, 'unsnooze.service')));
});

test('unsupported platform → null, never throws', () => {
  assert.equal(installDaemonAutostart({ platform: 'win32', dir: DIR, activate: () => true }), null);
  assert.equal(uninstallDaemonAutostart({ platform: 'win32', dir: DIR, activate: () => true }), null);
});

test('launchd plist carries the install-time PATH (daemon revival needs tmux)', () => {
  // launchd gives daemons PATH=/usr/bin:/bin:/usr/sbin:/sbin — tmux lives in
  // /opt/homebrew/bin on ARM Macs, so without this every daemon revival dies
  // with spawn tmux ENOENT (observed live: 5 silent attempts, then give-up).
  const xml = launchdPlist({ nodeBin: '/n/node', unsnoozeBin: '/x/bin/unsnooze.js', path: '/opt/homebrew/bin:/usr/bin:/bin' });
  assert.match(xml, /<key>EnvironmentVariables<\/key>/);
  assert.match(xml, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/);
  // Default: bakes the installing shell's PATH (which can find tmux).
  const dflt = launchdPlist({ nodeBin: '/n/node', unsnoozeBin: '/x/bin/unsnooze.js' });
  assert.match(dflt, /<key>PATH<\/key>/);
});

test('systemd unit carries the install-time PATH too', () => {
  const unit = systemdUnit({ nodeBin: '/n/node', unsnoozeBin: '/x/bin/unsnooze.js', path: '/usr/local/bin:/usr/bin:/bin' });
  assert.match(unit, /Environment="PATH=\/usr\/local\/bin:\/usr\/bin:\/bin"/);
});

test('systemd PATH escapes percent specifiers', () => {
  const unit = systemdUnit({ nodeBin: '/n/node', unsnoozeBin: '/x/bin/unsnooze.js', path: '/odd%dir/bin' });
  assert.match(unit, /Environment="PATH=\/odd%%dir\/bin"/);
});

test('healDaemonAutostart regenerates a PATH-less unit and reloads it (one-time self-heal)', () => {
  // Users who update via npm never re-run `install --daemon`, so the old
  // PATH-less plist (the daemon-cant-find-tmux bug) would persist forever.
  // The daemon self-heals on startup instead.
  const calls = [];
  const dir = join(DIR, 'heal-la');
  // Plant an OLD-style plist: no EnvironmentVariables block.
  installDaemonAutostart({ platform: 'darwin', dir, activate: () => true });
  const target = join(dir, `${DAEMON_LABEL}.plist`);
  const stripped = readFileSync(target, 'utf-8')
    .replace(/ {2}<!-- launchd default PATH[\s\S]*?<\/dict>\n/, '');
  writeFileSync(target, stripped);
  assert.doesNotMatch(readFileSync(target, 'utf-8'), /EnvironmentVariables/, 'fixture is the old shape');

  const healed = healDaemonAutostart({ platform: 'darwin', dir, activate: (cmd, args) => calls.push([cmd, ...args]) });
  assert.equal(healed, target, 'reports the healed unit');
  assert.match(readFileSync(target, 'utf-8'), /<key>PATH<\/key>/, 'unit now carries PATH');
  assert.ok(calls.some(c => c[0] === 'launchctl'), 'unit reloaded so the fix takes effect');
});

test('healDaemonAutostart is a no-op on a current unit or when autostart is not installed', () => {
  const dir = join(DIR, 'heal-la2');
  installDaemonAutostart({ platform: 'darwin', dir, activate: () => true });
  assert.equal(healDaemonAutostart({ platform: 'darwin', dir, activate: () => true }), null,
    'unit already has PATH → untouched');
  assert.equal(healDaemonAutostart({ platform: 'darwin', dir: join(DIR, 'nowhere'), activate: () => true }), null,
    'no unit file → no daemon-autostart user → nothing to heal');
});

test('healDaemonAutostart heals the Linux systemd unit the same way', () => {
  const dir = join(DIR, 'heal-sys');
  installDaemonAutostart({ platform: 'linux', dir, activate: () => true });
  const target = join(dir, 'unsnooze.service');
  writeFileSync(target, readFileSync(target, 'utf-8').split('\n')
    .filter(l => !l.startsWith('Environment="PATH=')).join('\n'));
  const calls = [];
  const healed = healDaemonAutostart({ platform: 'linux', dir, activate: (cmd, args) => calls.push([cmd, ...args]) });
  assert.equal(healed, target);
  assert.match(readFileSync(target, 'utf-8'), /Environment="PATH=/);
  assert.ok(calls.some(c => c[0] === 'systemctl'));
});

// --- supervision detection --------------------------------------------------
// A supervised daemon may exit on version skew because launchd/systemd bring it
// back. An unsupervised one must not: nothing would restart it and GUI watching
// would stop silently. Both env shapes below were read off real processes on a
// live machine — the supervised one from `ps eww` on the running launchd
// daemon, the unsupervised one from an ordinary interactive shell.

test('isSupervised recognises our own launchd job, and nothing else', () => {
  assert.equal(isSupervised({ platform: 'darwin', env: { XPC_SERVICE_NAME: DAEMON_LABEL } }), true,
    'observed on the live launchd daemon: XPC_SERVICE_NAME is the job label');
  assert.equal(isSupervised({ platform: 'darwin', env: { XPC_SERVICE_NAME: '0' } }), false,
    'observed in an interactive shell: launchd reports 0');
  assert.equal(isSupervised({ platform: 'darwin', env: {} }), false);
  assert.equal(isSupervised({ platform: 'darwin', env: { XPC_SERVICE_NAME: 'com.apple.Terminal' } }), false,
    'some other launchd job is not our supervisor');
});

test('isSupervised recognises a systemd user unit by INVOCATION_ID', () => {
  assert.equal(isSupervised({ platform: 'linux', env: { INVOCATION_ID: 'b1946ac92492d234' } }), true);
  assert.equal(isSupervised({ platform: 'linux', env: { INVOCATION_ID: '' } }), false, 'empty is not set');
  assert.equal(isSupervised({ platform: 'linux', env: {} }), false);
});

test('isSupervised is false where we install no supervisor at all', () => {
  assert.equal(isSupervised({ platform: 'win32', env: { XPC_SERVICE_NAME: DAEMON_LABEL, INVOCATION_ID: 'x' } }), false);
});

// --- daemon PATH: the self-heal that could not heal ------------------------
// Observed live: a launchd daemon running with PATH=/usr/bin:/bin:/usr/sbin:/sbin
// while tmux sat in /opt/homebrew/bin, so every revival died with ENOENT.
// healDaemonAutostart regenerates the unit from process.env.PATH of the
// CALLER — and the only caller is the daemon, whose PATH is the very thing
// being repaired. It wrote the broken PATH back, then (marker now present)
// marked itself done forever.

import { mkdirSync } from 'node:fs';

// A PATH that provably cannot find tmux ANYWHERE. Real system dirs are not
// usable for this: tmux is /opt/homebrew/bin/tmux on macOS but /usr/bin/tmux on
// the Ubuntu CI image, so "/usr/bin:/bin" is a broken PATH on one and a working
// one on the other. Empty temp dirs are the only portable negative fixture.
const NO_TMUX = (() => {
  const a = join(DIR, 'empty-bin-a');
  const b = join(DIR, 'empty-bin-b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  return `${a}${delimiter}${b}`;
})();


// The daemon-autostart PATH feature is darwin/linux only — autostartUnitPath
// returns null on win32, so there is no unit for any of this to act on.
// Exercising it with Windows temp paths embedded in a launchd plist tests
// nothing real, so these are skipped there rather than contorted.
const UNIX_ONLY = process.platform === 'win32'
  ? 'daemon autostart units exist only on darwin/linux'
  : false;

function fakeBinDir(name, bin = 'tmux') {
  const d = join(DIR, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, bin), '#!/bin/sh\n');
  return d;
}

test('autostartUnitPath names the unit per platform, and nothing elsewhere', () => {
  assert.equal(autostartUnitPath({ platform: 'darwin', dir: '/x' }), join('/x', `${DAEMON_LABEL}.plist`));
  assert.equal(autostartUnitPath({ platform: 'linux', dir: '/x' }), join('/x', 'unsnooze.service'));
  assert.equal(autostartUnitPath({ platform: 'win32', dir: '/x' }), null);
});

test('pathResolves answers whether a PATH string can actually find the binary', () => {
  const good = fakeBinDir('has-tmux');
  assert.equal(pathResolves(`${good}${delimiter}/usr/bin`, 'tmux'), true);
  assert.equal(pathResolves(NO_TMUX, 'tmux'), false,
    "stands in for the launchd default PATH on a host where tmux lives elsewhere");
  assert.equal(pathResolves('', 'tmux'), false);
  assert.equal(pathResolves(null, 'tmux'), false);
  assert.equal(pathResolves(`${delimiter}${delimiter}${good}${delimiter}${delimiter}`, 'tmux'), true, 'empty segments are skipped');
});

test('resolveLoginPath asks the login shell and hands back its PATH', () => {
  const calls = [];
  const runner = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return '/opt/homebrew/bin:/usr/bin\n'; };
  assert.equal(resolveLoginPath({ shell: '/bin/zsh', runner }), '/opt/homebrew/bin:/usr/bin');
  assert.equal(calls[0].cmd, '/bin/zsh');
  assert.ok(calls[0].args.includes('-lc'), 'a LOGIN shell, so profile files run');
  assert.ok(!('PATH' in (calls[0].opts?.env || {})),
    'PATH is stripped so the login files rebuild it instead of appending to the broken one');
});

test('resolveLoginPath returns null rather than a bad guess when the probe fails', () => {
  assert.equal(resolveLoginPath({ shell: '/bin/zsh', runner: () => { throw new Error('timeout'); } }), null);
  assert.equal(resolveLoginPath({ shell: '/bin/zsh', runner: () => '' }), null);
  assert.equal(resolveLoginPath({ shell: '/bin/zsh', runner: () => '   \n' }), null);
  assert.equal(resolveLoginPath({ shell: null, runner: () => '/usr/bin' }), null, 'no shell to ask');
});

test('heal repairs a unit whose baked PATH cannot find tmux', { skip: UNIX_ONLY }, () => {
  const dir = join(DIR, 'heal-badpath');
  const good = fakeBinDir('good-bin');
  installDaemonAutostart({ platform: 'darwin', dir, activate: () => true, path: NO_TMUX });
  const target = join(dir, `${DAEMON_LABEL}.plist`);
  assert.match(readFileSync(target, 'utf-8'), /EnvironmentVariables/, 'fixture already has the marker');

  const calls = [];
  const healed = healDaemonAutostart({
    platform: 'darwin', dir, activate: (cmd, args) => calls.push([cmd, ...args]),
    resolvePath: () => `${good}${delimiter}/usr/bin`, muxBin: 'tmux', currentPath: NO_TMUX,
  });
  assert.equal(healed, target, 'a present-but-useless PATH is not "already current"');
  assert.match(readFileSync(target, 'utf-8'), new RegExp(good.replace(/[/]/g, '\\/')));
  assert.ok(calls.some(c => c[0] === 'launchctl'), 'reloaded so the fix takes effect');
});

test('heal does NOT rewrite when the probe offers nothing better — the crash-loop guard', { skip: UNIX_ONLY }, () => {
  // Healing reloads the unit, which kills the calling daemon. A heal that
  // fires every start is a 30s restart loop, which is worse than the bug.
  const dir = join(DIR, 'heal-noloop');
  installDaemonAutostart({ platform: 'darwin', dir, activate: () => true, path: NO_TMUX });
  const before = readFileSync(join(dir, `${DAEMON_LABEL}.plist`), 'utf-8');

  for (const [label, resolvePath] of [
    ['probe failed', () => null],
    ['probe returned the same broken PATH', () => NO_TMUX],
    ['probe returned a different but still tmux-less PATH', () => `${NO_TMUX}${delimiter}/nonexistent-xyz`],
  ]) {
    const calls = [];
    assert.equal(
      healDaemonAutostart({ platform: 'darwin', dir, activate: (c, a) => calls.push([c, ...a]), resolvePath, muxBin: 'tmux', currentPath: NO_TMUX }),
      null, `${label} → no rewrite`);
    assert.equal(calls.length, 0, `${label} → no reload, so no restart loop`);
    assert.equal(readFileSync(join(dir, `${DAEMON_LABEL}.plist`), 'utf-8'), before, `${label} → unit untouched`);
  }
});

test('heal leaves a healthy unit alone', { skip: UNIX_ONLY }, () => {
  const dir = join(DIR, 'heal-healthy');
  const good = fakeBinDir('healthy-bin');
  installDaemonAutostart({ platform: 'darwin', dir, activate: () => true, path: `${good}${delimiter}/usr/bin` });
  assert.equal(
    healDaemonAutostart({ platform: 'darwin', dir, activate: () => true, resolvePath: () => '/other', muxBin: 'tmux', currentPath: NO_TMUX }),
    null, 'a PATH that already finds tmux is current — never touched');
});

test('a PATH-less unit still heals, and prefers a working PATH over the caller\'s broken one', { skip: UNIX_ONLY }, () => {
  const dir = join(DIR, 'heal-legacy-badcaller');
  const good = fakeBinDir('legacy-bin');
  installDaemonAutostart({ platform: 'darwin', dir, activate: () => true });
  const target = join(dir, `${DAEMON_LABEL}.plist`);
  writeFileSync(target, readFileSync(target, 'utf-8').replace(/ {2}<key>EnvironmentVariables[\s\S]*?<\/dict>\n/, ''));
  assert.doesNotMatch(readFileSync(target, 'utf-8'), /EnvironmentVariables/);

  const healed = healDaemonAutostart({
    platform: 'darwin', dir, activate: () => true,
    resolvePath: () => `${good}${delimiter}/usr/bin`, muxBin: 'tmux', currentPath: NO_TMUX,
  });
  assert.equal(healed, target);
  assert.match(readFileSync(target, 'utf-8'), new RegExp(good.replace(/[/]/g, '\\/')),
    'the daemon must not bake its own tmux-less PATH back in');
});

test('linux heal reads and repairs the systemd Environment PATH', { skip: UNIX_ONLY }, () => {
  const dir = join(DIR, 'heal-sys-badpath');
  const good = fakeBinDir('sys-bin');
  installDaemonAutostart({ platform: 'linux', dir, activate: () => true, path: NO_TMUX });
  const target = join(dir, 'unsnooze.service');
  const healed = healDaemonAutostart({
    platform: 'linux', dir, activate: () => true,
    resolvePath: () => `${good}${delimiter}/usr/bin`, muxBin: 'tmux', currentPath: NO_TMUX,
  });
  assert.equal(healed, target);
  assert.match(readFileSync(target, 'utf-8'), new RegExp(`Environment="PATH=${good.replace(/[/]/g, '\\/')}`));
});

test('the real activator never runs against a unit path outside the live location', () => {
  // Every unit we write carries the same label, so `launchctl load` on a
  // fixture copy hijacks the user's actual daemon rather than adding a second
  // one. This happened for real during development: a doctor --fix test that
  // forgot to inject `activate` repointed the live job at a temp dir that the
  // test's own cleanup then deleted. Writing must still work; only the real
  // activation is withheld.
  const dir = join(DIR, 'interlock');
  const target = installDaemonAutostart({ platform: 'darwin', dir });   // no activate injected
  assert.ok(existsSync(target), 'the unit is still written');

  // An explicitly injected activator is always honored — that is a caller
  // stating intent, and it is how every other test drives this code.
  const calls = [];
  installDaemonAutostart({ platform: 'darwin', dir, activate: (c, a) => calls.push([c, ...a]) });
  assert.ok(calls.some(c => c[0] === 'launchctl'), 'injected activators still run');
});
