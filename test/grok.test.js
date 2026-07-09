import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-grok-test-'));

const grok = (await import('../src/agents/grok.js')).default;
const { installGrokHooks, uninstallGrokHooks, isCommunityGrokCli } = await import('../src/agents/grok.js');
const { getAgent } = await import('../src/agents/index.js');
const { detectLimit } = await import('../src/patterns.js');
const { buildIssueUrl } = await import('../src/report.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

test('grok is registered and experimental', () => {
  assert.equal(getAgent('grok').id, 'grok');
  assert.equal(getAgent('grok').experimental, true);
});

test('generic patterns catch plausible limit banners (exact text unconfirmed upstream)', () => {
  const candidates = [
    'Rate limit exceeded. Please wait a moment and try again.',
    'You have reached your usage quota. Try again at 3:00 PM.',
    "You've hit your usage limit for this billing period.",
    'Your workspace is out of credits.',
  ];
  for (const banner of candidates) {
    const d = detectLimit(`${banner}\n› \n`, 12, grok.patterns);
    assert.equal(d.hit, true, `should detect: ${banner}`);
  }
});

test('normal output is not a limit', () => {
  assert.equal(detectLimit('I refactored the rate limiter module for you.\n› \n', 12, grok.patterns).hit, false);
});

test('grok resume args use --resume / -c with message typed into the pane', () => {
  const withId = grok.resumeArgs('abc', 'go');
  assert.deepEqual(withId.args, ['--resume', 'abc']);
  assert.equal(withId.messageViaPane, true);
  assert.deepEqual(grok.resumeArgs(null, 'go').args, ['-c']);
});

test('installGrokHooks writes a Claude-compatible StopFailure hook file', () => {
  const grokDir = join(DIR, 'grok-home');
  installGrokHooks({ grokDir });
  const file = join(grokDir, 'hooks', 'unsnooze.json');
  assert.ok(existsSync(file));
  const parsed = JSON.parse(readFileSync(file, 'utf-8'));
  const entry = parsed.hooks.StopFailure[0];
  assert.match(entry.hooks[0].command, /_hook-stopfailure --agent grok/);
  uninstallGrokHooks({ grokDir });
  assert.ok(!existsSync(file));
});

test('community grok-cli is distinguished from Grok Build', () => {
  const communityDir = join(DIR, 'community');
  mkdirSync(communityDir, { recursive: true });
  writeFileSync(join(communityDir, 'user-settings.json'), '{}');
  assert.equal(isCommunityGrokCli({ grokDir: communityDir }), true);
  const officialDir = join(DIR, 'official');
  mkdirSync(officialDir, { recursive: true });
  writeFileSync(join(officialDir, 'config.toml'), '');
  assert.equal(isCommunityGrokCli({ grokDir: officialDir }), false);
});

test('buildIssueUrl embeds agent and capture, stays URL-safe', () => {
  const url = buildIssueUrl('grok', 'You hit a "limit" & stuff\nline2');
  assert.ok(url.startsWith('https://github.com/'));
  assert.ok(url.includes('title='));
  assert.ok(!url.includes(' '), 'must be fully encoded');
  assert.ok(decodeURIComponent(url).includes('You hit a "limit" & stuff'));
});
