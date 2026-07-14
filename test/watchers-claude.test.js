// Claude transcript-line parser: turns appended ~/.claude/projects JSONL lines
// into limit-stop candidates. Fixture shapes captured from real transcripts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TX_DIR = mkdtempSync(join(tmpdir(), 'unsnooze-tx-'));
process.env.UNSNOOZE_CLAUDE_DIR = join(TX_DIR, 'claude');

const { parseTranscriptLine, latestRateLimitFromTranscript } = await import('../src/watchers/claude.js');
const { detectLimit } = await import('../src/patterns.js');
const { patterns } = await import('../src/agents/claude.js');
const { dashCwd } = await import('../src/sessions.js');

after(() => rmSync(TX_DIR, { recursive: true, force: true }));

const SESSION_TEXT = "You've hit your session limit · resets 6:40pm (Asia/Calcutta)";
const WEEKLY_TEXT = "You've hit your weekly limit · resets Jul 4 at 12:30am (Asia/Calcutta)";

function transcriptLine(overrides = {}) {
  return JSON.stringify({
    parentUuid: 'p1',
    isSidechain: false,
    type: 'assistant',
    uuid: 'u1',
    timestamp: '2026-07-01T08:39:15.334Z',
    message: {
      model: '<synthetic>',
      role: 'assistant',
      content: [{ type: 'text', text: SESSION_TEXT }],
    },
    requestId: 'req_x',
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/tmp/proj',
    sessionId: 'sess-1',
    version: '2.1.197',
    gitBranch: 'main',
    ...overrides,
  });
}

test('detectLimit matches the weekly transcript form (resets <Month> <day> at <time>)', () => {
  const d = detectLimit(WEEKLY_TEXT, 12, patterns);
  assert.equal(d.hit, true);
  assert.equal(d.limitType, 'weekly');
  assert.equal(d.resetLine, WEEKLY_TEXT);
});

test('parses a session-limit rate_limit entry', () => {
  const rec = parseTranscriptLine(transcriptLine());
  assert.ok(rec);
  assert.equal(rec.sessionId, 'sess-1');
  assert.equal(rec.cwd, '/tmp/proj');
  assert.equal(rec.entrypoint, 'cli');
  assert.equal(rec.limitType, '5h');
  assert.equal(rec.resetLine, SESSION_TEXT);
  assert.equal(rec.timestampMs, Date.parse('2026-07-01T08:39:15.334Z'));
});

test('parses a weekly rate_limit entry', () => {
  const rec = parseTranscriptLine(transcriptLine({
    message: { role: 'assistant', content: [{ type: 'text', text: WEEKLY_TEXT }] },
  }));
  assert.ok(rec);
  assert.equal(rec.limitType, 'weekly');
  assert.equal(rec.resetLine, WEEKLY_TEXT);
});

test('non-rate_limit API errors are ignored', () => {
  assert.equal(parseTranscriptLine(transcriptLine({ error: 'server_error', apiErrorStatus: 500 })), null);
  assert.equal(parseTranscriptLine(transcriptLine({ error: 'authentication_failed', apiErrorStatus: 401 })), null);
});

test('sidechain (subagent) entries are ignored', () => {
  assert.equal(parseTranscriptLine(transcriptLine({ isSidechain: true })), null);
});

test('ordinary assistant messages are ignored', () => {
  const line = transcriptLine();
  const obj = JSON.parse(line);
  delete obj.error;
  delete obj.isApiErrorMessage;
  delete obj.apiErrorStatus;
  assert.equal(parseTranscriptLine(JSON.stringify(obj)), null);
});

test('non-JSON and empty lines are ignored', () => {
  assert.equal(parseTranscriptLine('not json {'), null);
  assert.equal(parseTranscriptLine(''), null);
  assert.equal(parseTranscriptLine('   '), null);
});

test('rate_limit with unrecognizable text still yields a record (fallback reset)', () => {
  const rec = parseTranscriptLine(transcriptLine({
    message: { role: 'assistant', content: [{ type: 'text', text: 'Something new we cannot parse' }] },
  }));
  assert.ok(rec);
  assert.equal(rec.resetLine, null);
  assert.equal(rec.limitType, 'unknown');
});

test('latestRateLimitFromTranscript returns newest rate_limit entry with bannerAt', () => {
  const cwd = '/tmp/tx-proj';
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const dir = join(TX_DIR, 'claude', 'projects', dashCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const old = transcriptLine({
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    sessionId,
    cwd,
    message: { role: 'assistant', content: [{ type: 'text', text: SESSION_TEXT }] },
  });
  const newerText = "You've hit your session limit · resets 10:40pm (Asia/Calcutta)";
  const neu = transcriptLine({
    timestamp: new Date().toISOString(),
    sessionId,
    cwd,
    message: { role: 'assistant', content: [{ type: 'text', text: newerText }] },
  });
  writeFileSync(join(dir, `${sessionId}.jsonl`), old + '\n' + neu + '\n');
  const c = latestRateLimitFromTranscript(cwd, sessionId, { now: Date.now() });
  assert.ok(c);
  assert.equal(c.resetLine, newerText);
  assert.ok(c.timestampMs);
});

test('latestRateLimitFromTranscript returns null for stale entries', () => {
  const cwd = '/tmp/tx-stale';
  const sessionId = '22222222-3333-4444-8555-666666666666';
  const dir = join(TX_DIR, 'claude', 'projects', dashCwd(cwd));
  mkdirSync(dir, { recursive: true });
  const old = transcriptLine({
    timestamp: new Date(Date.now() - 60 * 60_000).toISOString(), // 1h ago
    sessionId,
    cwd,
  });
  writeFileSync(join(dir, `${sessionId}.jsonl`), old + '\n');
  assert.equal(latestRateLimitFromTranscript(cwd, sessionId, { maxAgeMs: 15 * 60_000, now: Date.now() }), null);
});
