// Reviving a record with no session id.
//
// Every agent's no-id resume means "continue the newest session in this cwd"
// (`claude -c`, `codex resume --last`, `qwen --continue`). One such record
// revives that conversation. N of them revive N copies of it into the same
// repo — a weekly reset turned 23 accumulated pane-snapshot records into
// roughly 8 parallel clones of one conversation in production.
//
// The rule cannot be "anonymous records may not revive": Grok never has a
// session id at all, so that would disable it outright. It is "at most one
// anonymous record per agent+project", and preview has to reach the same
// verdict as dispatch or `unsnooze preview` lies about what will happen.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-anon-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';

const { supersedingAnonymousRecord } = await import('../src/resumer.js');

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const rec = (over = {}) => ({
  key: 'k1', agent: 'claude', cwd: '/repo', sessionId: null,
  status: 'stopped', detectedAt: 1_000, ...over,
});

const stateOf = (...records) => ({
  sessions: Object.fromEntries(records.map(r => [r.key, r])),
});

test('a record that knows its session id is never superseded', () => {
  const mine = rec({ key: 'a', sessionId: 'sess-1' });
  const other = rec({ key: 'b', detectedAt: 9_000 });
  assert.equal(supersedingAnonymousRecord(mine, stateOf(mine, other)), null);
});

test('the only anonymous record for a project revives — this is the Grok case', () => {
  const grok = rec({ key: 'a', agent: 'grok' });
  assert.equal(supersedingAnonymousRecord(grok, stateOf(grok)), null,
    'grok has no session id by design and must still resume');
});

test('among several anonymous records for one project, the newest wins', () => {
  const older = rec({ key: 'a', detectedAt: 1_000 });
  const newer = rec({ key: 'b', detectedAt: 5_000 });
  const state = stateOf(older, newer);
  assert.equal(supersedingAnonymousRecord(newer, state), null, 'the newest revives');
  assert.equal(supersedingAnonymousRecord(older, state)?.key, 'b', 'the older stands down');
});

test('the tie-break is deterministic, so preview and dispatch cannot disagree', () => {
  const a = rec({ key: 'a', detectedAt: 1_000 });
  const b = rec({ key: 'b', detectedAt: 1_000 });
  const state = stateOf(a, b);
  assert.equal(supersedingAnonymousRecord(b, state), null);
  assert.equal(supersedingAnonymousRecord(a, state)?.key, 'b');
});

test('bannerAt is what dates a record when it has one', () => {
  const older = rec({ key: 'a', detectedAt: 9_000, bannerAt: 1_000 });
  const newer = rec({ key: 'b', detectedAt: 1_000, bannerAt: 5_000 });
  assert.equal(supersedingAnonymousRecord(older, stateOf(older, newer))?.key, 'b');
});

test('a different project, or a different agent, is not a rival', () => {
  const mine = rec({ key: 'a', detectedAt: 1_000 });
  const otherRepo = rec({ key: 'b', cwd: '/elsewhere', detectedAt: 9_000 });
  const otherAgent = rec({ key: 'c', agent: 'codex', detectedAt: 9_000 });
  assert.equal(supersedingAnonymousRecord(mine, stateOf(mine, otherRepo, otherAgent)), null);
});

test('records that are done are not rivals — only live ones compete', () => {
  const mine = rec({ key: 'a', detectedAt: 1_000 });
  const finished = rec({ key: 'b', detectedAt: 9_000, status: 'resumed' });
  const failed = rec({ key: 'c', detectedAt: 9_000, status: 'failed' });
  assert.equal(supersedingAnonymousRecord(mine, stateOf(mine, finished, failed)), null);
});

test('a resuming rival still counts — it is already reviving the conversation', () => {
  const mine = rec({ key: 'a', detectedAt: 1_000 });
  const inFlight = rec({ key: 'b', detectedAt: 9_000, status: 'resuming' });
  assert.equal(supersedingAnonymousRecord(mine, stateOf(mine, inFlight))?.key, 'b');
});

test('the production shape: 23 anonymous records for one repo yield exactly one revival', () => {
  const records = Array.from({ length: 23 }, (_, i) =>
    rec({ key: `k${i}`, detectedAt: 1_000 + i }));
  const state = stateOf(...records);
  const revive = records.filter(r => supersedingAnonymousRecord(r, state) === null);
  assert.equal(revive.length, 1, 'one conversation, one revival');
  assert.equal(revive[0].key, 'k22', 'and it is the newest');
});
