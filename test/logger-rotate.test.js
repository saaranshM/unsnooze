// Log rotation: unsnooze.log and daemon.log must never grow unbounded
// (observed: a 10.3 MB daemon.log from one upgrade-window crash-loop).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-logrotate-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { rotateIfLarge, copyTruncateIfLarge, log } = await import('../src/logger.js');
const { LOG_FILE } = await import('../src/config.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

test('rotateIfLarge leaves small files alone', () => {
  const p = join(DIR, 'small.log');
  writeFileSync(p, 'hello\n');
  assert.equal(rotateIfLarge(p, 1024), false);
  assert.equal(readFileSync(p, 'utf-8'), 'hello\n');
  assert.ok(!existsSync(`${p}.1`));
});

test('rotateIfLarge moves an oversized file to .1 (one generation kept)', () => {
  const p = join(DIR, 'big.log');
  writeFileSync(p, 'x'.repeat(2048));
  assert.equal(rotateIfLarge(p, 1024), true);
  assert.ok(!existsSync(p), 'original must be renamed away');
  assert.equal(statSync(`${p}.1`).size, 2048);
  // A second oversized file replaces the old .1 — never a .2.
  writeFileSync(p, 'y'.repeat(4096));
  assert.equal(rotateIfLarge(p, 1024), true);
  assert.equal(statSync(`${p}.1`).size, 4096);
  assert.ok(!existsSync(`${p}.2`));
});

test('rotateIfLarge on a missing path is a no-op, never throws', () => {
  assert.equal(rotateIfLarge(join(DIR, 'nope.log'), 1024), false);
});

test('log() rotates unsnooze.log once it crosses the cap', () => {
  // Fill past the cap with one giant line, then log normally.
  writeFileSync(LOG_FILE, 'z'.repeat(5 * 1024 * 1024 + 1));
  log('test', 'first line after rotation');
  assert.ok(existsSync(`${LOG_FILE}.1`), 'oversized log must rotate to .1');
  const fresh = readFileSync(LOG_FILE, 'utf-8');
  assert.match(fresh, /first line after rotation/);
  assert.ok(statSync(LOG_FILE).size < 1024, 'fresh log must start near-empty');
});

test('copyTruncateIfLarge caps a file in place (for fds other processes hold open)', () => {
  // launchd keeps daemon.log open across the daemon's lifetime — renaming it
  // would leave launchd writing to the renamed inode forever. Copy-truncate
  // preserves the inode: the copy becomes .1, the live file drops to zero.
  const p = join(DIR, 'held-open.log');
  writeFileSync(p, 'x'.repeat(2048));
  assert.equal(copyTruncateIfLarge(p, 1024), true);
  assert.equal(statSync(p).size, 0, 'live file truncated in place');
  assert.equal(statSync(`${p}.1`).size, 2048, 'previous contents preserved as .1');
  assert.equal(copyTruncateIfLarge(p, 1024), false, 'now-small file untouched');
  assert.equal(copyTruncateIfLarge(join(DIR, 'absent.log'), 1024), false, 'missing → no-op');
});
