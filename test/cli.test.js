// `unsnooze config` argument handling.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-cli-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { cmdConfig } = await import('../src/cli.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

test('config set accepts an empty value to clear a per-agent message', () => {
  assert.equal(cmdConfig(['set', 'resumeMessages.claude', 'be brief']), 0);
  let onDisk = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf-8'));
  assert.equal(onDisk.resumeMessages.claude, 'be brief');
  assert.equal(cmdConfig(['set', 'resumeMessages.claude', '']), 0);
  onDisk = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf-8'));
  assert.equal(onDisk.resumeMessages.claude, '');
});

test('config set with a missing value still prints usage', () => {
  assert.equal(cmdConfig(['set', 'resumeMessages.claude']), 2);
  assert.equal(cmdConfig(['set']), 2);
});
