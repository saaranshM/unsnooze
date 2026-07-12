// Kimi CLI adapter: banner fixtures use the exact strings from
// MoonshotAI/kimi-cli (src/kimi_cli/ui/shell/__init__.py, _live_view.py) and
// the api.kimi.com 429 body — a CLI update that changes them should fail here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-kimi-test-'));
process.env.UNSNOOZE_KIMI_DIR = DIR;

const { default: kimi, latestSessionId } = await import('../src/agents/kimi.js');
const { getAgent } = await import('../src/agents/index.js');
const { detectLimit, isBusy, overloadMatch } = await import('../src/patterns.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

const RED_429 = `LLM provider error: Error code: 429 - {'error': {'message': "We're receiving too many requests at the moment. Please wait a moment and try again.", 'type': 'rate_limit_reached_error'}}`;

test('kimi is registered and experimental', () => {
  assert.equal(getAgent('kimi').id, 'kimi');
  assert.equal(kimi.experimental, true);
});

test('detects the terminal red 429 line as a limit stop', () => {
  const pane = `⏺ working on it\n\n${RED_429}\nIf this persists, run kimi export and send the exported data to support for assistance.\n\n> \n`;
  const d = detectLimit(pane, 12, kimi.patterns);
  assert.equal(d.hit, true);
  assert.ok(d.resetLine, 'resetLine captured (feeds the 5h fallback)');
});

test('transient retry line is busy + overload, NOT a limit', () => {
  const pane = 'Retrying after rate limit · attempt 2/3 · 1.2s\n';
  assert.equal(detectLimit(pane, 12, kimi.patterns).hit, false);
  assert.equal(isBusy(pane, kimi.patterns.busyPatterns), true);
  assert.ok(overloadMatch(pane, kimi.patterns.overloadPatterns));
});

test('membership expiry is terminal, not a limit', () => {
  const pane = 'LLM provider error: Membership expired, please renew your plan\n> \n';
  assert.equal(detectLimit(pane, 12, kimi.patterns).hit, false);
  assert.ok(overloadMatch(pane, kimi.patterns.terminalPatterns));
});

test('5xx provider errors are overloads, not limits', () => {
  const pane = "LLM provider error: Error code: 503 - {'error': {'message': 'upstream unavailable'}}\n";
  assert.equal(detectLimit(pane, 12, kimi.patterns).hit, false);
  assert.ok(overloadMatch(pane, kimi.patterns.overloadPatterns));
});

test('agent prose about rate limits is not a limit stop', () => {
  const pane = '⏺ The API docs say a rate limit of 30 concurrent requests applies,\n  so the importer should back off on 429s.\n\n> \n';
  assert.equal(detectLimit(pane, 12, kimi.patterns).hit, false);
});

// --- resume invocation (argv prompt, with the silent-new-session guard) ---

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('resumeArgs resumes by id when the session dir exists', () => {
  const hash = createHash('md5').update('/tmp/proj-k').digest('hex');
  mkdirSync(join(DIR, 'sessions', hash, SID), { recursive: true });
  const r = kimi.resumeArgs(SID, 'continue');
  assert.deepEqual(r.args, ['-r', SID, '-p', 'continue']);
  assert.equal(r.messageViaPane, false);
});

test('resumeArgs falls back to --continue for unknown ids (kimi would silently start a NEW session)', () => {
  const r = kimi.resumeArgs('99999999-9999-4999-8999-999999999999', 'continue');
  assert.deepEqual(r.args, ['--continue', '-p', 'continue']);
  assert.equal(r.messageViaPane, false);
});

test('resumeArgs without id uses --continue', () => {
  const r = kimi.resumeArgs(null, 'continue');
  assert.deepEqual(r.args, ['--continue', '-p', 'continue']);
});

test('kimi foreground command covers the python shim', () => {
  assert.equal(kimi.isForegroundCommand('kimi'), true);
  assert.equal(kimi.isForegroundCommand('python3'), true);
  assert.equal(kimi.isForegroundCommand('python3.12'), true);
  // macOS framework builds report a capitalized process name (verified live).
  assert.equal(kimi.isForegroundCommand('Python'), true);
  assert.equal(kimi.isForegroundCommand('node'), true);
  assert.equal(kimi.isForegroundCommand('zsh'), false);
});

// --- latestSessionId: kimi.json workdir map, then md5 session-dir scan ---

test('latestSessionId reads the kimi.json workdir map', () => {
  writeFileSync(join(DIR, 'kimi.json'), JSON.stringify({
    work_dirs: { '/tmp/proj-k': { last_session_id: SID } },
  }));
  assert.equal(latestSessionId('/tmp/proj-k', null, DIR), SID);
});

test('latestSessionId falls back to the newest session dir under md5(cwd)', () => {
  const cwd = '/tmp/proj-m';
  const hash = createHash('md5').update(cwd).digest('hex');
  const older = '11111111-1111-4111-8111-111111111111';
  const newer = '22222222-2222-4222-8222-222222222222';
  mkdirSync(join(DIR, 'sessions', hash, older), { recursive: true });
  mkdirSync(join(DIR, 'sessions', hash, newer), { recursive: true });
  const past = Date.now() / 1000 - 3600;
  utimesSync(join(DIR, 'sessions', hash, older), past, past);
  assert.equal(latestSessionId(cwd, null, DIR), newer);
});

test('latestSessionId returns null for unknown workdir', () => {
  assert.equal(latestSessionId('/nope/never', null, DIR), null);
});
