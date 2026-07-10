// `unsnooze config` argument handling and top-level CLI routing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

test('help, -h and --help print the unsnooze usage', () => {
  const bin = fileURLToPath(new URL('../bin/unsnooze.js', import.meta.url));
  for (const flag of ['help', '-h', '--help']) {
    const r = spawnSync(process.execPath, [bin, flag], {
      encoding: 'utf-8',
      // UNSNOOZE_ACTIVE + a stub bin: if routing ever regresses to the
      // claude-passthrough branch, the test fails fast instead of launching
      // a real agent or tmux session.
      env: { ...process.env, UNSNOOZE_STATE_DIR: DIR, UNSNOOZE_ACTIVE: '1', UNSNOOZE_CLAUDE_BIN: '/bin/echo' },
    });
    assert.equal(r.status, 0, `${flag} must exit 0`);
    assert.match(r.stdout, /Usage:/, `${flag} must print usage`);
    for (const cmd of ['status', 'resume-now', 'cancel', 'logs', 'config', 'setup', 'install', 'uninstall', 'report', 'help']) {
      assert.ok(r.stdout.includes(`unsnooze ${cmd}`), `${flag} usage must document "unsnooze ${cmd}"`);
    }
  }
});
