// `unsnooze prompt` local CLI: add/list/remove/clear, --at parsing, the
// --host Task-5 stub, and the cmdStatus queue block. Every queueAdd path
// here goes through cmdPrompt with spawn suppressed — never a real forked
// resumer (see prompt-dispatch.test.js's header for why that matters).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// state.js/settings.js read UNSNOOZE_STATE_DIR at import time — set it BEFORE
// importing anything that touches state.
const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-prompt-cli-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';

const { cmdPrompt, parseAtTime } = await import('../src/prompt.js');
const { cmdStatus } = await import('../src/cli.js');
const { queueList, queueAdd } = await import('../src/prompt-queue.js');
const { updateState } = await import('../src/state.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

function resetState() {
  updateState(state => { state.sessions = {}; state.promptQueue = []; return state; });
}

function capture(streamName) {
  const stream = console[streamName];
  const lines = [];
  console[streamName] = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => { console[streamName] = stream; } };
}

async function runPrompt(args, opts) {
  const out = capture('log');
  const err = capture('error');
  try {
    const code = await cmdPrompt(args, { spawn: false, ...opts });
    return { code, stdout: out.lines.join('\n'), stderr: err.lines.join('\n') };
  } finally {
    out.restore();
    err.restore();
  }
}

// --- add ---------------------------------------------------------------

test('add happy path: non-TTY defaults to claude and writes a pending entry', async () => {
  resetState();
  const r = await runPrompt(['add', '--project', '/tmp', 'finish', 'the', 'refactor']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /queued prompt p-[0-9a-f]{8} for claude in/);
  const entries = queueList();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].agent, 'claude');
  assert.equal(entries[0].prompt, 'finish the refactor');
  assert.equal(entries[0].mode, 'next-reset');
  assert.equal(entries[0].cwd, '/tmp');
});

test('add --project resolves to an absolute path and defaults to cwd', async () => {
  resetState();
  const r = await runPrompt(['add', 'hi'], {});
  assert.equal(r.code, 0);
  assert.equal(queueList()[0].cwd, process.cwd());
});

test('add --project pointing at a missing directory errors', async () => {
  resetState();
  const r = await runPrompt(['add', '--project', '/tmp/definitely-not-here-xyz', 'hi']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /does not exist or is not a directory/);
  assert.equal(queueList().length, 0);
});

test('add --project pointing at a file (not a directory) errors', async () => {
  resetState();
  const { writeFileSync } = await import('node:fs');
  const file = join(DIR, 'not-a-dir.txt');
  writeFileSync(file, 'x');
  const r = await runPrompt(['add', '--project', file, 'hi']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /does not exist or is not a directory/);
});

test('add --agent invalid lists the valid ids', async () => {
  resetState();
  const r = await runPrompt(['add', '--project', '/tmp', '--agent', 'nope', 'hi']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown or disabled agent "nope"/);
  assert.match(r.stderr, /claude/);
});

test('add --agent disabled-but-registered (grok, off by default) is rejected', async () => {
  resetState();
  const r = await runPrompt(['add', '--project', '/tmp', '--agent', 'grok', 'hi']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown or disabled agent "grok"/);
});

test('add --agent valid (codex, enabled by default) succeeds', async () => {
  resetState();
  const r = await runPrompt(['add', '--project', '/tmp', '--agent', 'codex', 'hi']);
  assert.equal(r.code, 0);
  assert.equal(queueList()[0].agent, 'codex');
});

test('add: injectable prompter supplies the agent when --agent is omitted', async () => {
  resetState();
  let askedWith = null;
  const prompter = async ids => { askedWith = ids; return 'codex'; };
  const r = await runPrompt(['add', '--project', '/tmp', 'hi'], { prompter });
  assert.equal(r.code, 0);
  assert.deepEqual(askedWith, ['claude', 'codex']);
  assert.equal(queueList()[0].agent, 'codex');
});

test('add: injectable prompter cancel (returns null) aborts without queuing', async () => {
  resetState();
  const prompter = async () => null;
  const r = await runPrompt(['add', '--project', '/tmp', 'hi'], { prompter });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cancelled/);
  assert.equal(queueList().length, 0);
});

test('add --at and --now together is an error', async () => {
  resetState();
  const r = await runPrompt(['add', '--project', '/tmp', '--at', '9pm', '--now', 'hi']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--at and --now cannot both be given/);
});

test('add --now queues mode "now"', async () => {
  resetState();
  const r = await runPrompt(['add', '--project', '/tmp', '--now', 'hi']);
  assert.equal(r.code, 0);
  assert.equal(queueList()[0].mode, 'now');
});

test('add --at with an unparseable time errors', async () => {
  resetState();
  const r = await runPrompt(['add', '--project', '/tmp', '--at', 'whenever', 'hi']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not parse --at/);
  assert.equal(queueList().length, 0);
});

test('add --at with a valid time queues mode "at" with the resolved atMs', async () => {
  resetState();
  const r = await runPrompt(['add', '--project', '/tmp', '--at', '+45m', 'hi']);
  assert.equal(r.code, 0);
  const entry = queueList()[0];
  assert.equal(entry.mode, 'at');
  assert.ok(entry.atMs > Date.now());
});

test('add: no active limit → informational next-daemon-tick message', async () => {
  resetState();
  const r = await runPrompt(['add', '--project', '/tmp', 'hi']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no active limit detected for claude.*next daemon tick/);
});

test('add: duplicate (same cwd/agent/prompt, still pending) errors mentioning the existing id', async () => {
  resetState();
  const first = await runPrompt(['add', '--project', '/tmp', 'dup', 'me']);
  assert.equal(first.code, 0);
  const existingId = queueList()[0].id;
  const second = await runPrompt(['add', '--project', '/tmp', 'dup', 'me']);
  assert.equal(second.code, 1);
  assert.match(second.stderr, new RegExp(`duplicate.*${existingId}`));
  assert.equal(queueList().length, 1);
});

// --- parseAtTime ---------------------------------------------------------

test('parseAtTime: table-driven forms', () => {
  const now = new Date('2026-07-19T10:00:00').getTime();

  assert.equal(parseAtTime('1791234567890', now), 1791234567890, 'epoch ms (>1e12)');
  assert.equal(parseAtTime('1791234567', now), 1791234567000, 'epoch seconds (1e9-1e12) * 1000');
  assert.equal(parseAtTime('2026-07-20T09:00:00', now), Date.parse('2026-07-20T09:00:00'), 'ISO-8601');
  assert.equal(parseAtTime('+2h30m', now), now + (2 * 3_600_000 + 30 * 60_000), '+2h30m duration');
  assert.equal(parseAtTime('+45m', now), now + 45 * 60_000, '+45m duration');

  const d1430 = new Date(parseAtTime('14:30', now));
  assert.equal(d1430.getHours(), 14);
  assert.equal(d1430.getMinutes(), 30);
  assert.ok(d1430.getTime() > now, '14:30 (still ahead of 10:00) stays today');

  const d205pm = new Date(parseAtTime('2:05pm', now));
  assert.equal(d205pm.getHours(), 14);
  assert.equal(d205pm.getMinutes(), 5);

  const d7pm = new Date(parseAtTime('7pm', now));
  assert.equal(d7pm.getHours(), 19);
  assert.equal(d7pm.getMinutes(), 0);

  // clock-time roll-forward: 9am relative to a 10am "now" has already passed
  // today, so it must resolve to tomorrow, never a past time.
  const rolled = parseAtTime('9am', now);
  assert.ok(rolled > now, 'rolled-forward clock time is never in the past');
  const rolledDate = new Date(rolled);
  assert.equal(rolledDate.getDate(), new Date(now).getDate() + 1);
  assert.equal(rolledDate.getHours(), 9);

  assert.equal(parseAtTime('not a real time at all', now), null, 'garbage -> null');
  assert.equal(parseAtTime('', now), null, 'empty -> null');
  assert.equal(parseAtTime(null, now), null, 'non-string -> null');
});

// --- list ----------------------------------------------------------------

test('list: empty queue prints "no queued prompts" and exits 0', async () => {
  resetState();
  const r = await runPrompt(['list']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no queued prompts/);
});

test('list: plain output shows id/agent/status/cwd/truncated prompt', async () => {
  resetState();
  const longPrompt = 'x'.repeat(120);
  queueAdd({ cwd: '/tmp', agent: 'claude', prompt: longPrompt, spawn: false });
  const r = await runPrompt(['list']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /1 queued prompt/);
  assert.match(r.stdout, /claude/);
  assert.match(r.stdout, /pending/);
  // truncated to 60 chars + ellipsis, not the full 120-char prompt
  assert.ok(!r.stdout.includes(longPrompt));
  assert.match(r.stdout, new RegExp(`"${'x'.repeat(60)}…"`));
});

test('list --json returns the raw queueList() shape', async () => {
  resetState();
  queueAdd({ cwd: '/tmp', agent: 'claude', prompt: 'hi', spawn: false });
  const r = await runPrompt(['list', '--json']);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].prompt, 'hi');
});

// --- remove / clear --------------------------------------------------------

test('remove: unknown id errors, exit 1', async () => {
  resetState();
  const r = await runPrompt(['remove', 'p-doesnotexist']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no pending\/launching prompt/);
});

test('remove: known pending id succeeds', async () => {
  resetState();
  const { entry } = queueAdd({ cwd: '/tmp', agent: 'claude', prompt: 'hi', spawn: false });
  const r = await runPrompt(['remove', entry.id]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, new RegExp(entry.id));
});

test('clear: cancels every pending/launching entry and reports the count', async () => {
  resetState();
  queueAdd({ cwd: '/tmp', agent: 'claude', prompt: 'a', spawn: false });
  queueAdd({ cwd: '/tmp', agent: 'claude', prompt: 'b', spawn: false });
  const r = await runPrompt(['clear']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /cleared 2 queued prompt/);
});

// --- --host stub (Task 5 seam) --------------------------------------------

test('--host with add prints the fleet-update stub and exits 1', async () => {
  resetState();
  const r = await runPrompt(['add', '--host', 'my-host', '--project', '/tmp', 'hi']);
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'prompt: --host support lands with the fleet update');
  assert.equal(queueList().length, 0);
});

test('--host with list/remove/clear all hit the same stub', async () => {
  resetState();
  for (const args of [['list', '--host', 'h'], ['remove', 'p-1', '--host', 'h'], ['clear', '--host', 'h']]) {
    const r = await runPrompt(args);
    assert.equal(r.code, 1);
    assert.equal(r.stderr, 'prompt: --host support lands with the fleet update');
  }
});

// --- cmdStatus queue block --------------------------------------------------

test('cmdStatus: empty queue -> no "queued prompts" section', async () => {
  resetState();
  const out = capture('log');
  try { await cmdStatus(); } finally { out.restore(); }
  assert.doesNotMatch(out.lines.join('\n'), /queued prompts/);
});

test('cmdStatus: with a pending entry, a "queued prompts" section appears', async () => {
  resetState();
  const { entry } = queueAdd({ cwd: '/tmp/proj-status', agent: 'claude', prompt: 'do stuff', mode: 'now', spawn: false });
  const out = capture('log');
  try { await cmdStatus(); } finally { out.restore(); }
  const text = out.lines.join('\n');
  assert.match(text, /queued prompts: 1/);
  assert.match(text, new RegExp(entry.id));
  assert.match(text, /claude/);
});

test('cmdStatus: terminal (cancelled) entries do not appear in the section', async () => {
  resetState();
  const { entry } = queueAdd({ cwd: '/tmp/proj-status2', agent: 'claude', prompt: 'x', spawn: false });
  const { queueRemove } = await import('../src/prompt-queue.js');
  queueRemove(entry.id);
  const out = capture('log');
  try { await cmdStatus(); } finally { out.restore(); }
  assert.doesNotMatch(out.lines.join('\n'), /queued prompts/);
});

test('cmdStatus --json includes a promptQueue array', async () => {
  resetState();
  queueAdd({ cwd: '/tmp/proj-status3', agent: 'claude', prompt: 'json me', spawn: false });
  const out = capture('log');
  try { await cmdStatus(['--json']); } finally { out.restore(); }
  const parsed = JSON.parse(out.lines.join(''));
  assert.ok(Array.isArray(parsed.promptQueue));
  assert.equal(parsed.promptQueue.length, 1);
  assert.equal(parsed.promptQueue[0].prompt, 'json me');
});
