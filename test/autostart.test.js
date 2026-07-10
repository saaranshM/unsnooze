// Daemon autostart: launchd plist / systemd user unit generation + install.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchdPlist, systemdUnit, installDaemonAutostart, uninstallDaemonAutostart, DAEMON_LABEL,
} from '../src/install.js';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-autostart-test-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

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

test('systemdUnit execs the daemon and restarts on failure', () => {
  const unit = systemdUnit({ nodeBin: '/usr/bin/node', unsnoozeBin: '/x/bin/unsnooze.js' });
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/x\/bin\/unsnooze\.js" daemon/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);
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
