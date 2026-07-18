// Queue core: state promptQueue plumbing, CRUD, sanitization, due-ness.
// No dispatch here — this only covers src/prompt-queue.js + the additive
// src/state.js changes it depends on.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// state.js reads UNSNOOZE_STATE_DIR at import time, so set it BEFORE importing.
const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-prompt-queue-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { readState, updateState, prune } = await import('../src/state.js');
const STATE_FILE_PATH = join(DIR, 'state.json');
const { writeUsageStore } = await import('../src/usage.js');
const {
  sanitizePrompt, queueAdd, queueList, queueRemove, queueClear,
  resolveAgentResetAnchor, duePromptEntries,
} = await import('../src/prompt-queue.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

function resetState() {
  rmSync(STATE_FILE_PATH, { force: true });
}

// --- normalize ---

test('state file without promptQueue reads as []', () => {
  resetState();
  writeFileSync(STATE_FILE_PATH, JSON.stringify({ version: 1, sessions: {} }));
  const state = readState();
  assert.deepEqual(state.promptQueue, []);
});

test('corrupt promptQueue (object) normalizes to []', () => {
  resetState();
  writeFileSync(STATE_FILE_PATH, JSON.stringify({ version: 1, sessions: {}, promptQueue: { oops: true } }));
  const state = readState();
  assert.deepEqual(state.promptQueue, []);
});

// --- queueAdd ---

test('queueAdd happy path persists to state.json', () => {
  resetState();
  const result = queueAdd({ cwd: '/tmp/proj-a', agent: 'claude', prompt: 'do the thing' });
  assert.equal(result.ok, true);
  assert.match(result.entry.id, /^p-[0-9a-f]{8}$/);
  assert.equal(result.entry.cwd, '/tmp/proj-a');
  assert.equal(result.entry.agent, 'claude');
  assert.equal(result.entry.prompt, 'do the thing');
  assert.equal(result.entry.mode, 'next-reset');
  assert.equal(result.entry.atMs, null);
  assert.equal(result.entry.notBefore, 0);
  assert.equal(result.entry.status, 'pending');
  assert.equal(result.entry.attempts, 0);
  assert.equal(result.entry.lastError, null);
  assert.equal(result.entry.deliveredAt, null);
  assert.equal(result.entry.pane, null);
  assert.equal(result.entry.createdBy, 'local');
  assert.ok(Number.isFinite(result.entry.createdAt));

  const onDisk = JSON.parse(readFileSync(STATE_FILE_PATH, 'utf-8'));
  assert.equal(onDisk.promptQueue.length, 1);
  assert.equal(onDisk.promptQueue[0].id, result.entry.id);
});

test('queueAdd rejects a relative cwd', () => {
  resetState();
  const result = queueAdd({ cwd: 'relative/path', agent: 'claude', prompt: 'hi' });
  assert.equal(result.ok, false);
  assert.match(result.error, /absolute/i);
});

test('queueAdd rejects an unknown agent', () => {
  resetState();
  const result = queueAdd({ cwd: '/tmp/proj', agent: 'not-a-real-agent', prompt: 'hi' });
  assert.equal(result.ok, false);
  assert.match(result.error, /agent/i);
});

test('queueAdd rejects a prompt that is empty after sanitization', () => {
  resetState();
  const result = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: '\x1b[31m\x03   ' });
  assert.equal(result.ok, false);
  assert.match(result.error, /prompt/i);
});

test('queueAdd rejects a bad mode', () => {
  resetState();
  const result = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'hi', mode: 'whenever' });
  assert.equal(result.ok, false);
  assert.match(result.error, /mode/i);
});

test('queueAdd rejects mode "at" without a finite atMs', () => {
  resetState();
  const result = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'hi', mode: 'at', atMs: NaN });
  assert.equal(result.ok, false);
  assert.match(result.error, /atMs/i);
});

test('queueAdd dedupes identical pending (cwd, agent, prompt)', () => {
  resetState();
  const first = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'same prompt' });
  assert.equal(first.ok, true);
  const second = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'same prompt' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'duplicate');
  assert.equal(second.existing.id, first.entry.id);
  assert.equal(queueList().length, 1);
});

test('queueAdd caps at 50 non-terminal entries', () => {
  resetState();
  for (let i = 0; i < 50; i += 1) {
    const r = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: `prompt number ${i}` });
    assert.equal(r.ok, true, `entry ${i} should succeed`);
  }
  const overflow = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'one too many' });
  assert.equal(overflow.ok, false);
  assert.equal(overflow.error, 'queue full');
  assert.equal(queueList().length, 50);
});

// --- sanitizePrompt ---

test('sanitizePrompt strips ESC/CSI sequences', () => {
  assert.equal(sanitizePrompt('hello \x1b[31mred\x1b[0m world'), 'hello red world');
});

test('sanitizePrompt strips OSC sequences', () => {
  assert.equal(sanitizePrompt('hello \x1b]0;title\x07 world'), 'hello  world');
});

test('sanitizePrompt strips C0 control chars but keeps \\n and \\t', () => {
  assert.equal(sanitizePrompt('a\x03b\nc\td'), 'ab\nc\td');
});

test('sanitizePrompt normalizes CRLF and lone CR to LF', () => {
  assert.equal(sanitizePrompt('line1\r\nline2\rline3'), 'line1\nline2\nline3');
});

test('sanitizePrompt trims and caps length at 4000', () => {
  assert.equal(sanitizePrompt('  padded  '), 'padded');
  const long = 'x'.repeat(5000);
  assert.equal(sanitizePrompt(long).length, 4000);
});

// --- queueRemove / queueClear ---

test('queueRemove cancels a pending entry and returns true', () => {
  resetState();
  const { entry } = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'remove me' });
  assert.equal(queueRemove(entry.id), true);
  const found = queueList().find(e => e.id === entry.id);
  assert.equal(found.status, 'cancelled');
});

test('queueRemove returns false for an unknown id', () => {
  resetState();
  assert.equal(queueRemove('p-deadbeef'), false);
});

test('queueRemove returns false for an already-terminal entry', () => {
  resetState();
  const { entry } = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'already gone' });
  assert.equal(queueRemove(entry.id), true);
  assert.equal(queueRemove(entry.id), false);
});

test('queueClear cancels only pending/launching entries and returns the count', () => {
  resetState();
  const a = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'a' }).entry;
  const b = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'b' }).entry;
  updateState(state => {
    const rec = state.promptQueue.find(e => e.id === b.id);
    rec.status = 'launching';
    return state;
  });
  const c = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'c' }).entry;
  updateState(state => {
    const rec = state.promptQueue.find(e => e.id === c.id);
    rec.status = 'delivered';
    return state;
  });
  const count = queueClear();
  assert.equal(count, 2);
  const list = queueList();
  assert.equal(list.find(e => e.id === a.id).status, 'cancelled');
  assert.equal(list.find(e => e.id === b.id).status, 'cancelled');
  assert.equal(list.find(e => e.id === c.id).status, 'delivered');
});

// --- prune ---

test('prune removes old terminal promptQueue entries, keeps pending and recent terminal', () => {
  resetState();
  const OLD = Date.now() - 8 * 86_400_000;   // beyond default 7-day PRUNE_AFTER_MS
  const RECENT = Date.now() - 1000;
  updateState(state => {
    state.promptQueue = [
      { id: 'p-old00001', cwd: '/tmp/a', agent: 'claude', prompt: 'old delivered', mode: 'now',
        atMs: null, notBefore: 0, createdAt: OLD, createdBy: 'local', status: 'delivered',
        attempts: 1, lastError: null, deliveredAt: OLD, pane: null, muxSession: null, leaseId: null },
      { id: 'p-old00002', cwd: '/tmp/a', agent: 'claude', prompt: 'old failed, no deliveredAt', mode: 'now',
        atMs: null, notBefore: 0, createdAt: OLD, createdBy: 'local', status: 'failed',
        attempts: 1, lastError: 'boom', deliveredAt: null, pane: null, muxSession: null, leaseId: null },
      { id: 'p-recent001', cwd: '/tmp/a', agent: 'claude', prompt: 'recent cancelled', mode: 'now',
        atMs: null, notBefore: 0, createdAt: RECENT, createdBy: 'local', status: 'cancelled',
        attempts: 0, lastError: null, deliveredAt: RECENT, pane: null, muxSession: null, leaseId: null },
      { id: 'p-pending01', cwd: '/tmp/a', agent: 'claude', prompt: 'still pending, old createdAt', mode: 'now',
        atMs: null, notBefore: 0, createdAt: OLD, createdBy: 'local', status: 'pending',
        attempts: 0, lastError: null, deliveredAt: null, pane: null, muxSession: null, leaseId: null },
    ];
    return state;
  });
  updateState(state => { prune(state); return state; });
  const ids = queueList().map(e => e.id).sort();
  assert.deepEqual(ids, ['p-pending01', 'p-recent001']);
});

// --- duePromptEntries ---

test('duePromptEntries: "now" mode entries are always due', () => {
  resetState();
  const { entry } = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'immediate', mode: 'now' });
  const due = duePromptEntries(Date.now(), { anchors: {} });
  assert.deepEqual(due.map(e => e.id), [entry.id]);
});

test('duePromptEntries: "at" mode respects atMs boundary', () => {
  resetState();
  const now = Date.now();
  const past = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'past', mode: 'at', atMs: now - 1000 }).entry;
  const future = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'future', mode: 'at', atMs: now + 100_000 }).entry;
  const due = duePromptEntries(now, { anchors: {} });
  const ids = due.map(e => e.id);
  assert.ok(ids.includes(past.id));
  assert.ok(!ids.includes(future.id));
});

test('duePromptEntries: "next-reset" with future anchor is not due', () => {
  resetState();
  const now = Date.now();
  queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'waiting on reset' });
  const due = duePromptEntries(now, { anchors: { claude: { resetAtMs: now + 3_600_000 } } });
  assert.equal(due.length, 0);
});

test('duePromptEntries: "next-reset" with past anchor is due', () => {
  resetState();
  const now = Date.now();
  const entry = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'reset already happened' }).entry;
  const due = duePromptEntries(now, { anchors: { claude: { resetAtMs: now - 1000 } } });
  assert.deepEqual(due.map(e => e.id), [entry.id]);
});

test('duePromptEntries: "next-reset" with null anchor (no known future reset) is due', () => {
  resetState();
  const entry = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'no signal' }).entry;
  const due = duePromptEntries(Date.now(), { anchors: { claude: { resetAtMs: null } } });
  assert.deepEqual(due.map(e => e.id), [entry.id]);
});

test('duePromptEntries: notBefore in the future blocks an otherwise-due entry', () => {
  resetState();
  const now = Date.now();
  const { entry } = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'backoff floor' });
  updateState(state => {
    state.promptQueue.find(e => e.id === entry.id).notBefore = now + 60_000;
    return state;
  });
  const due = duePromptEntries(now, { anchors: { claude: { resetAtMs: null } } });
  assert.equal(due.length, 0);
});

test('duePromptEntries preserves FIFO order across mixed modes', () => {
  resetState();
  const a = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'a', mode: 'now' }).entry;
  const b = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'b', mode: 'now' }).entry;
  const c = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'c', mode: 'now' }).entry;
  const due = duePromptEntries(Date.now(), { anchors: {} });
  assert.deepEqual(due.map(e => e.id), [a.id, b.id, c.id]);
});

test('duePromptEntries resolves anchors per distinct agent when anchors not injected', () => {
  resetState();
  const now = Date.now();
  // Seed a stopped claude record with a future reset so the real anchor
  // resolution path (no injected anchors) reports "not due".
  updateState(state => {
    state.sessions['sess-1'] = {
      key: 'sess-1', agent: 'claude', status: 'stopped', pane: '%1', mux: 'tmux',
      detectedAt: now, resetAt: now + 3_600_000, resetSource: 'absolute',
    };
    return state;
  });
  const { entry } = queueAdd({ cwd: '/tmp/proj', agent: 'claude', prompt: 'real anchor path' });
  const due = duePromptEntries(now);
  assert.deepEqual(due.map(e => e.id), []);
  assert.notEqual(entry, undefined);
});

// --- resolveAgentResetAnchor ---

test('resolveAgentResetAnchor: claude delegates to resolveClaudeResetAnchor via a stopped record', () => {
  resetState();
  const now = Date.now();
  const state = updateState(s => {
    s.sessions['sess-claude'] = {
      key: 'sess-claude', agent: 'claude', status: 'stopped', pane: '%1', mux: 'tmux',
      detectedAt: now, resetAt: now + 2 * 3_600_000, resetSource: 'absolute',
    };
    return s;
  });
  const anchor = resolveAgentResetAnchor('claude', { sessions: state.sessions, now });
  assert.notEqual(anchor.resetAtMs, null);
  assert.ok(anchor.resetAtMs > now);
});

test('resolveAgentResetAnchor: unknown agent with no records returns null anchor', () => {
  resetState();
  const anchor = resolveAgentResetAnchor('some-unregistered-agent', { sessions: {}, now: Date.now() });
  assert.deepEqual(anchor, { resetAtMs: null, source: null });
});

test('resolveAgentResetAnchor: generic agent picks the min future resetAt among its stopped/resuming records', () => {
  resetState();
  const now = Date.now();
  const sessions = {
    a: { key: 'a', agent: 'grok', status: 'stopped', resetAt: now + 5_000_000 },
    b: { key: 'b', agent: 'grok', status: 'resuming', resetAt: now + 2_000_000 },
    c: { key: 'c', agent: 'grok', status: 'stopped', resetAt: now - 10_000 },   // past, ignored
    d: { key: 'd', agent: 'other', status: 'stopped', resetAt: now + 1_000 },   // different agent, ignored
  };
  const anchor = resolveAgentResetAnchor('grok', { sessions, now });
  assert.equal(anchor.resetAtMs, now + 2_000_000 - 60_000);
  assert.equal(anchor.source, 'record');
});

test('resolveAgentResetAnchor: codex prefers a future usage-store sample over records', () => {
  resetState();
  const now = Date.now();
  writeUsageStore({
    version: 1, samples: [
      { agent: 'codex', at: now - 1000, primary: { resetsAtMs: now + 900_000 } },
    ], fired: {}, pending: {}, ewma: {}, exactPct: { claude5h: [] },
  });
  const sessions = { a: { key: 'a', agent: 'codex', status: 'stopped', resetAt: now + 5_000_000 } };
  const anchor = resolveAgentResetAnchor('codex', { sessions, now });
  assert.equal(anchor.resetAtMs, now + 900_000);
  assert.equal(anchor.source, 'usage-store');
});

test('resolveAgentResetAnchor: codex falls back to records when the usage-store sample is stale', () => {
  resetState();
  const now = Date.now();
  writeUsageStore({
    version: 1, samples: [
      { agent: 'codex', at: now - 1000, primary: { resetsAtMs: now - 900_000 } },   // in the past
    ], fired: {}, pending: {}, ewma: {}, exactPct: { claude5h: [] },
  });
  const sessions = { a: { key: 'a', agent: 'codex', status: 'stopped', resetAt: now + 2_000_000 } };
  const anchor = resolveAgentResetAnchor('codex', { sessions, now });
  assert.equal(anchor.resetAtMs, now + 2_000_000 - 60_000);
  assert.equal(anchor.source, 'record');
});
