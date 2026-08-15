// launchExtraArgs: the launch-side twin of resumeExtraArgs.
//
// Issue #13's reporter runs context-heavy Claude Design sessions that "consume
// available tokens very quickly". Claude Code has a lever for exactly that —
// --autocompact — but there was nowhere to put it: resumeExtraArgs only
// applies to launches unsnooze performs itself, so a flag set there took
// effect on revives and not on the session the user actually started.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveLaunchExtraArgs, DEFAULTS } from '../src/settings.js';

const originalEnv = { ...process.env };
const dirs = [];

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function isolated() {
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-lea-'));
  dirs.push(dir);
  process.env.UNSNOOZE_STATE_DIR = dir;
  return dir;
}

test('every agent has a launchExtraArgs slot, defaulting to nothing', () => {
  assert.ok(DEFAULTS.launchExtraArgs, 'the setting exists');
  for (const id of Object.keys(DEFAULTS.resumeExtraArgs)) {
    assert.equal(DEFAULTS.launchExtraArgs[id], '',
      `${id} must have a launch slot too, or getConfig throws on it`);
  }
});

test('a string setting is split into argv the way a shell would', () => {
  isolated();
  process.env.UNSNOOZE_LAUNCH_EXTRA_ARGS_CLAUDE = '--autocompact 400000';
  assert.deepEqual(resolveLaunchExtraArgs('claude'), ['--autocompact', '400000']);
});

test('quoted arguments survive as one argv entry', () => {
  isolated();
  process.env.UNSNOOZE_LAUNCH_EXTRA_ARGS_CLAUDE = '--append-system-prompt "be terse"';
  assert.deepEqual(resolveLaunchExtraArgs('claude'), ['--append-system-prompt', 'be terse']);
});

test('an unset or unknown agent contributes no argv', () => {
  isolated();
  assert.deepEqual(resolveLaunchExtraArgs('claude'), []);
  assert.deepEqual(resolveLaunchExtraArgs('nonexistent'), []);
  assert.deepEqual(resolveLaunchExtraArgs(null), []);
});

test('launch and resume extra args are independent settings', () => {
  isolated();
  process.env.UNSNOOZE_LAUNCH_EXTRA_ARGS_CLAUDE = '--autocompact auto';
  process.env.UNSNOOZE_RESUME_EXTRA_ARGS_CLAUDE = '--dangerously-skip-permissions';
  assert.deepEqual(resolveLaunchExtraArgs('claude'), ['--autocompact', 'auto']);
});
