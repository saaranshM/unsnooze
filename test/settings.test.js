import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-settings-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { getConfig, setConfigValue, listConfig, DEFAULTS } = await import('../src/settings.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

test('defaults apply when no config file exists', () => {
  assert.equal(getConfig('autoResume'), true);
  assert.equal(getConfig('menuAutoAnswer'), true);
  assert.equal(getConfig('notifications'), true);
  assert.equal(getConfig('agents.claude'), true);
  assert.equal(getConfig('agents.grok'), false);
  assert.equal(typeof getConfig('resumeMessage'), 'string');
});

test('config file overrides defaults', () => {
  writeFileSync(join(DIR, 'config.json'), JSON.stringify({ autoResume: false, agents: { codex: false } }));
  assert.equal(getConfig('autoResume'), false);
  assert.equal(getConfig('agents.codex'), false);
  assert.equal(getConfig('agents.claude'), true);   // unspecified keys keep defaults
  rmSync(join(DIR, 'config.json'));
});

test('env var overrides file and default', () => {
  writeFileSync(join(DIR, 'config.json'), JSON.stringify({ notifications: true }));
  process.env.UNSNOOZE_NOTIFICATIONS = 'off';
  assert.equal(getConfig('notifications'), false);
  delete process.env.UNSNOOZE_NOTIFICATIONS;
  process.env.UNSNOOZE_RESUME_MESSAGE = 'just continue';
  assert.equal(getConfig('resumeMessage'), 'just continue');
  delete process.env.UNSNOOZE_RESUME_MESSAGE;
  rmSync(join(DIR, 'config.json'));
});

test('setConfigValue writes dot-paths and persists', () => {
  setConfigValue('autoResume', 'false');
  assert.equal(getConfig('autoResume'), false);
  setConfigValue('agents.grok', 'on');
  assert.equal(getConfig('agents.grok'), true);
  const onDisk = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf-8'));
  assert.equal(onDisk.autoResume, false);
  assert.equal(onDisk.agents.grok, true);
  setConfigValue('autoResume', 'true');
});

test('setConfigValue rejects unknown keys and bad types', () => {
  assert.throws(() => setConfigValue('nonsense', 'true'), /unknown setting/i);
  assert.throws(() => setConfigValue('agents.claude', 'maybe'), /boolean/i);
});

test('listConfig returns every known key with its effective value', () => {
  const listed = listConfig();
  for (const key of ['autoResume', 'menuAutoAnswer', 'notifications', 'resumeMessage', 'agents.claude', 'agents.codex', 'agents.grok']) {
    assert.ok(key in listed, `${key} missing from listConfig`);
  }
});

test('DEFAULTS include grok disabled (experimental)', () => {
  assert.equal(DEFAULTS.agents.grok, false);
});
