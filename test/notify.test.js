import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-notify-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { notify } = await import('../src/notify.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

test('darwin uses osascript with escaped strings', () => {
  const calls = [];
  notify('Limit hit', 'session "x" stopped', { platform: 'darwin', spawner: (cmd, args) => calls.push({ cmd, args }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'osascript');
  assert.match(calls[0].args.join(' '), /display notification/);
  assert.ok(!calls[0].args.join(' ').includes('session "x"'), 'quotes must be escaped inside the AppleScript literal');
});

test('linux uses notify-send', () => {
  const calls = [];
  notify('Resumed', 'all good', { platform: 'linux', spawner: (cmd, args) => calls.push({ cmd, args }) });
  assert.equal(calls[0].cmd, 'notify-send');
  assert.deepEqual(calls[0].args.slice(-2), ['Resumed', 'all good']);
});

test('notifications toggle off → nothing fires', () => {
  process.env.UNSNOOZE_NOTIFICATIONS = 'off';
  const calls = [];
  notify('x', 'y', { platform: 'darwin', spawner: (cmd, args) => calls.push({ cmd, args }) });
  assert.equal(calls.length, 0);
  delete process.env.UNSNOOZE_NOTIFICATIONS;
});

test('spawner errors are swallowed', () => {
  assert.doesNotThrow(() => notify('x', 'y', { platform: 'linux', spawner: () => { throw new Error('boom'); } }));
});
