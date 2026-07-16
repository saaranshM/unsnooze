// Version-skew guard: a long-lived daemon whose loaded code no longer matches
// the on-disk package must exit cleanly so launchd/systemd restart it on
// fresh code (the "zombie daemon running deleted code" failure mode).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-skew-'));
process.env.UNSNOOZE_STATE_DIR = join(DIR, 'state');

const { hasVersionSkew, PKG_VERSION } = await import('../src/update-check.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

function writePkg(version) {
  writeFileSync(join(DIR, 'package.json'), JSON.stringify({ name: 'unsnooze', version }));
  return DIR;
}

test('no skew when disk version matches the loaded version', () => {
  assert.equal(hasVersionSkew({ root: writePkg(PKG_VERSION) }), false);
});

test('skew when the on-disk package is any different version', () => {
  assert.equal(hasVersionSkew({ root: writePkg('999.0.0') }), true);
  assert.equal(hasVersionSkew({ root: writePkg('0.0.1') }), true);
});

test('missing or unreadable package.json is NOT skew (mid-upgrade window)', () => {
  // While npm swaps files out, package.json may briefly not exist; exiting
  // then would race the installer. Only a *different, readable* version is
  // proof the upgrade finished.
  assert.equal(hasVersionSkew({ root: join(DIR, 'nonexistent') }), false);
  writeFileSync(join(DIR, 'package.json'), '{ not json');
  assert.equal(hasVersionSkew({ root: DIR }), false);
});

test('defaults read the real package root and therefore report no skew', () => {
  assert.equal(hasVersionSkew(), false);
});
