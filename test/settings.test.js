import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-settings-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { getConfig, setConfigValue, listConfig, resolveResumeMessage, readFileConfig, DEFAULTS } = await import('../src/settings.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

test('defaults apply when no config file exists', () => {
  assert.equal(getConfig('autoResume'), true);
  assert.equal(getConfig('menuAutoAnswer'), true);
  assert.equal(getConfig('notifications'), true);
  assert.equal(getConfig('notifyChannel'), 'auto');
  assert.equal(getConfig('agents.claude'), true);
  assert.equal(getConfig('agents.grok'), false);
  assert.equal(typeof getConfig('resumeMessage'), 'string');
  assert.equal(getConfig('usageWarn'), 'notify');
  assert.equal(getConfig('usageWarnAt'), '80,95');
});

test('usageWarn enum + env override', () => {
  setConfigValue('usageWarn', 'off');
  assert.equal(getConfig('usageWarn'), 'off');
  process.env.UNSNOOZE_USAGE_WARN = 'notify';
  assert.equal(getConfig('usageWarn'), 'notify');
  delete process.env.UNSNOOZE_USAGE_WARN;
  setConfigValue('usageWarn', 'notify');
  assert.throws(() => setConfigValue('usageWarn', 'maybe'), /must be one of/i);
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
  for (const key of ['autoResume', 'menuAutoAnswer', 'notifications', 'notifyChannel', 'resumeMessage', 'agents.claude', 'agents.codex', 'agents.grok', 'resumeMessages.claude', 'resumeMessages.codex', 'resumeMessages.grok']) {
    assert.ok(key in listed, `${key} missing from listConfig`);
  }
});

test('per-agent resume messages default to unset → global message', () => {
  assert.equal(getConfig('resumeMessages.claude'), '');
  assert.equal(resolveResumeMessage('claude'), DEFAULTS.resumeMessage);
});

test('per-agent file value overrides global; empty string means unset', () => {
  writeFileSync(join(DIR, 'config.json'), JSON.stringify({
    resumeMessage: 'global msg',
    resumeMessages: { codex: 'codex msg', grok: '' },
  }));
  assert.equal(resolveResumeMessage('codex'), 'codex msg');
  assert.equal(resolveResumeMessage('claude'), 'global msg');   // no override → global
  assert.equal(resolveResumeMessage('grok'), 'global msg');     // '' → unset → global
  rmSync(join(DIR, 'config.json'));
});

test('per-agent env beats file; per-agent file beats global env', () => {
  writeFileSync(join(DIR, 'config.json'), JSON.stringify({
    resumeMessage: 'global msg',
    resumeMessages: { claude: 'claude file msg' },
  }));
  process.env.UNSNOOZE_RESUME_MESSAGE_CLAUDE = 'claude env msg';
  assert.equal(resolveResumeMessage('claude'), 'claude env msg');
  delete process.env.UNSNOOZE_RESUME_MESSAGE_CLAUDE;
  process.env.UNSNOOZE_RESUME_MESSAGE = 'global env msg';
  assert.equal(resolveResumeMessage('claude'), 'claude file msg');   // specificity beats source
  assert.equal(resolveResumeMessage('codex'), 'global env msg');
  delete process.env.UNSNOOZE_RESUME_MESSAGE;
  rmSync(join(DIR, 'config.json'));
});

test('resolveResumeMessage falls back to global for unknown agent ids', () => {
  assert.equal(resolveResumeMessage('nonsense'), DEFAULTS.resumeMessage);
  assert.equal(resolveResumeMessage(undefined), DEFAULTS.resumeMessage);
});

test('resolveResumeMessage treats whitespace-only values as unset', () => {
  writeFileSync(join(DIR, 'config.json'), JSON.stringify({
    resumeMessage: ' ',
    resumeMessages: { claude: '  ' },
  }));
  assert.equal(resolveResumeMessage('claude'), DEFAULTS.resumeMessage);
  rmSync(join(DIR, 'config.json'));
});

test('readFileConfig returns an object even when the file holds non-object JSON', () => {
  writeFileSync(join(DIR, 'config.json'), JSON.stringify('hi'));
  assert.deepEqual(readFileConfig(), {});
  rmSync(join(DIR, 'config.json'));
});

test('setConfigValue sets and clears per-agent messages', () => {
  setConfigValue('resumeMessages.claude', 'be quick');
  assert.equal(resolveResumeMessage('claude'), 'be quick');
  const onDisk = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf-8'));
  assert.equal(onDisk.resumeMessages.claude, 'be quick');
  setConfigValue('resumeMessages.claude', '');
  assert.equal(resolveResumeMessage('claude'), DEFAULTS.resumeMessage);
});

test('DEFAULTS include grok disabled (experimental)', () => {
  assert.equal(DEFAULTS.agents.grok, false);
});

test('workspaceGuard: enum setting with inform default', () => {
  assert.equal(getConfig('workspaceGuard'), 'inform');
  setConfigValue('workspaceGuard', 'pause');
  assert.equal(getConfig('workspaceGuard'), 'pause');
  assert.throws(() => setConfigValue('workspaceGuard', 'banana'), /one of/i);
  setConfigValue('workspaceGuard', 'inform');
});

test('contextGuard: enum setting with inform default', () => {
  assert.equal(getConfig('contextGuard'), 'inform');
  setConfigValue('contextGuard', 'pause');
  assert.equal(getConfig('contextGuard'), 'pause');
  assert.throws(() => setConfigValue('contextGuard', 'banana'), /one of/i);
  setConfigValue('contextGuard', 'inform');
});

test('contextGuardTokens: positive-integer setting with env and file coercion', () => {
  assert.equal(getConfig('contextGuardTokens'), 100_000);
  assert.equal(setConfigValue('contextGuardTokens', '150000'), 150_000);
  assert.equal(getConfig('contextGuardTokens'), 150_000);
  const onDisk = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf-8'));
  assert.equal(onDisk.contextGuardTokens, 150_000);
  assert.throws(() => setConfigValue('contextGuardTokens', 'abc'), /positive integer/i);
  assert.throws(() => setConfigValue('contextGuardTokens', '-5'), /positive integer/i);
  process.env.UNSNOOZE_CONTEXT_GUARD_TOKENS = '90000';
  assert.equal(getConfig('contextGuardTokens'), 90_000);
  process.env.UNSNOOZE_CONTEXT_GUARD_TOKENS = 'garbage';
  assert.equal(getConfig('contextGuardTokens'), 150_000);   // bad env ignored → file value
  delete process.env.UNSNOOZE_CONTEXT_GUARD_TOKENS;
  writeFileSync(join(DIR, 'config.json'), JSON.stringify({ contextGuardTokens: 'nope' }));
  assert.equal(getConfig('contextGuardTokens'), 100_000);   // garbage file value → default
  rmSync(join(DIR, 'config.json'));
});

test('notifyChannel: default auto, env override, enum rejection', () => {
  assert.equal(getConfig('notifyChannel'), 'auto');
  process.env.UNSNOOZE_NOTIFY_CHANNEL = 'osc';
  assert.equal(getConfig('notifyChannel'), 'osc');
  delete process.env.UNSNOOZE_NOTIFY_CHANNEL;
  setConfigValue('notifyChannel', 'native');
  assert.equal(getConfig('notifyChannel'), 'native');
  assert.throws(() => setConfigValue('notifyChannel', 'bogus'), /one of/i);
  setConfigValue('notifyChannel', 'auto');
});
