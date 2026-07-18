// Prompt queue delivery: dispatchPromptEntry / verifyPromptEntry /
// tickPromptQueue, plus the two additive resumer.js lifecycle changes
// (tickPromptQueue wired into the tick, exit condition waits on the queue).
// Fake mux objects throughout — never a real tmux/zellij backend, never a
// real forked resumer (queueAdd calls always pass spawn: false).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-prompt-dispatch-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';   // no desktop popups from tests
process.env.UNSNOOZE_READY_TIMEOUT_MS = '2500';   // keep the reopen poll short
process.env.UNSNOOZE_STAGGER_MS = '0';            // no real waits between dispatches
process.env.UNSNOOZE_VERIFY_DELAY_MS = '20000';   // keep the real default — tests inject `now`

const { readState, updateState, upsertSession } = await import('../src/state.js');
const {
  queueAdd, queueList, dispatchPromptEntry, verifyPromptEntry, tickPromptQueue,
} = await import('../src/prompt-queue.js');
const { runResumer, retryBackoffMs } = await import('../src/resumer.js');
const { RESUME_SESSION_NAME, VERIFY_DELAY_MS, MAX_RESUME_ATTEMPTS, RESET_MARGIN_MS, PROBE_INTERVAL_MS } = await import('../src/config.js');
const { parseResetTime, resetAtMs } = await import('../src/time-parser.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

const sleep = ms => new Promise(r => setTimeout(r, ms));

function resetState() {
  updateState(state => { state.sessions = {}; state.promptQueue = []; return state; });
}

function addEntry(overrides = {}) {
  const r = queueAdd({
    cwd: '/tmp/proj', agent: 'claude', prompt: 'do the thing', mode: 'now', spawn: false,
    ...overrides,
  });
  assert.equal(r.ok, true, `queueAdd failed: ${r.error}`);
  return r.entry;
}

function idleMux(overrides = {}) {
  return {
    name: 'tmux',
    newWindow: async () => ({ pane: '%501', paneOwner: null }),
    capturePane: async () => '❯ \n',
    sendText: async () => {},
    ...overrides,
  };
}

// --- dispatchPromptEntry --------------------------------------------------

test('dispatchPromptEntry: idle pane → prompt sent, entry recorded as launching', async () => {
  resetState();
  const entry = addEntry();
  const sent = [];
  const mux = idleMux({
    newWindow: async (session, cwd, spec) => {
      assert.equal(session, RESUME_SESSION_NAME);
      assert.equal(cwd, '/tmp/proj');
      assert.equal(spec.env.UNSNOOZE_MUX, 'tmux');
      assert.ok(spec.env.UNSNOOZE_LEASE_ID);
      assert.equal(spec.env.UNSNOOZE_CWD, '/tmp/proj');
      assert.ok(spec.args.includes('_run'));
      assert.ok(spec.args.includes('claude'));
      return { pane: '%501', paneOwner: null };
    },
    sendText: async (pane, text) => sent.push({ pane, text }),
  });
  const now = Date.now();
  const updated = await dispatchPromptEntry(entry, { mux, now });

  assert.equal(updated.status, 'launching');
  assert.equal(updated.pane, '%501');
  assert.equal(updated.muxSession, RESUME_SESSION_NAME);
  assert.ok(updated.leaseId);
  assert.equal(updated.sentAt, now);
  assert.deepEqual(sent, [{ pane: '%501', text: 'do the thing' }]);

  // Not yet due for verification.
  const tooSoon = await verifyPromptEntry(updated, { mux, now: now + 1 });
  assert.equal(tooSoon.status, 'launching');

  // Later verify (inject now past VERIFY_DELAY_MS) → delivered.
  const verified = await verifyPromptEntry(updated, { mux, now: now + VERIFY_DELAY_MS + 1000 });
  assert.equal(verified.status, 'delivered');
  assert.equal(verified.deliveredAt, now + VERIFY_DELAY_MS + 1000);
  assert.equal(verified.lastError, null);
});

test('verifyPromptEntry: pane unreadable (window closed) counts as delivered-unverifiable', async () => {
  resetState();
  const entry = addEntry();
  const mux = idleMux();
  const now = Date.now();
  const dispatched = await dispatchPromptEntry(entry, { mux, now });
  const closedMux = { ...mux, capturePane: async () => { throw new Error('no such pane'); } };
  const verified = await verifyPromptEntry(dispatched, { mux: closedMux, now: now + VERIFY_DELAY_MS + 1 });
  assert.equal(verified.status, 'delivered');
  assert.equal(verified.lastError, null);
});

test('dispatchPromptEntry: fresh pane shows a parseable limit banner → pending, notBefore = parsed reset epoch', async () => {
  resetState();
  const entry = addEntry();
  const resetLine = '· resets 3:30pm (UTC)';
  const bannerText = `⚠ You've hit your 5-hour limit\n${resetLine}\n> `;
  const mux = idleMux({ capturePane: async () => bannerText });
  const now = Date.now();
  const updated = await dispatchPromptEntry(entry, { mux, now });

  assert.equal(updated.status, 'pending');
  assert.equal(updated.attempts, 1);
  assert.equal(updated.lastError, 'limit still active');
  const expected = resetAtMs(parseResetTime(resetLine), {
    marginMs: RESET_MARGIN_MS, fallbackMs: PROBE_INTERVAL_MS, now: new Date(now),
  }).at;
  assert.equal(updated.notBefore, expected);
});

test('dispatchPromptEntry: limit menu with no parseable banner → notBefore = now + retryBackoffMs(1)', async () => {
  resetState();
  const entry = addEntry();
  const menuText = [
    'What do you want to do?',
    '❯ 1. Upgrade your plan',
    '  2. Stop and wait for limit to reset',
    'Enter to confirm · Esc to cancel',
  ].join('\n');
  const mux = idleMux({ capturePane: async () => menuText });
  const now = Date.now();
  const updated = await dispatchPromptEntry(entry, { mux, now });

  assert.equal(updated.status, 'pending');
  assert.equal(updated.attempts, 1);
  assert.equal(updated.notBefore, now + retryBackoffMs(1));
});

test('dispatchPromptEntry: ready timeout → pending with backoff', async () => {
  resetState();
  const entry = addEntry();
  const mux = idleMux({ capturePane: async () => '✻ Cogitating… (esc to interrupt)' });
  const now = Date.now();
  const updated = await dispatchPromptEntry(entry, { mux, now, readyTimeoutMs: 50 });

  assert.equal(updated.status, 'pending');
  assert.equal(updated.attempts, 1);
  assert.equal(updated.lastError, 'ready timeout');
  assert.equal(updated.notBefore, now + retryBackoffMs(1));
});

test('dispatchPromptEntry: newWindow throws → pending with backoff, entry never reaches launching', async () => {
  resetState();
  const entry = addEntry();
  const mux = { name: 'tmux', newWindow: async () => { throw new Error('spawn tmux ENOENT'); } };
  const now = Date.now();
  const updated = await dispatchPromptEntry(entry, { mux, now });

  assert.equal(updated.status, 'pending');
  assert.equal(updated.attempts, 1);
  assert.match(updated.lastError, /new-window.*ENOENT/);
  assert.equal(updated.notBefore, now + retryBackoffMs(1));
});

test('dispatchPromptEntry: attempts already at cap → failed, notify fired, no window opened', async () => {
  resetState();
  const entry = addEntry();
  updateState(state => {
    state.promptQueue.find(e => e.id === entry.id).attempts = MAX_RESUME_ATTEMPTS;
    return state;
  });
  let opened = false;
  const mux = idleMux({ newWindow: async () => { opened = true; return { pane: '%1' }; } });
  const toasts = [];
  const now = Date.now();
  const updated = await dispatchPromptEntry(readState().promptQueue.find(e => e.id === entry.id), {
    mux, now, notifier: (title, message, opts) => toasts.push({ title, message, opts }),
  });

  assert.equal(updated.status, 'failed');
  assert.equal(opened, false, 'must not open a window once the attempts cap is already hit');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, 'queued prompt failed ⚠️');
  assert.match(toasts[0].message, /\/tmp\/proj/);
  assert.equal(toasts[0].opts.priority, 4);
});

test('dispatchPromptEntry: entry already launching (lost the pending→launching race) → no window opened, status untouched', async () => {
  resetState();
  const entry = addEntry();
  updateState(state => {
    state.promptQueue.find(e => e.id === entry.id).status = 'launching';
    return state;
  });
  let opened = false;
  const mux = idleMux({ newWindow: async () => { opened = true; return { pane: '%1' }; } });
  const now = Date.now();
  const updated = await dispatchPromptEntry(readState().promptQueue.find(e => e.id === entry.id), { mux, now });

  assert.equal(opened, false, 'a caller that lost the CAS must never open a window');
  assert.equal(updated.status, 'launching', 'status must be left exactly as the winner set it');
});

// --- tickPromptQueue -------------------------------------------------------

test('tickPromptQueue: dispatches every due entry FIFO', async () => {
  resetState();
  const a = addEntry({ prompt: 'first' });
  const b = addEntry({ prompt: 'second' });
  const c = addEntry({ prompt: 'third' });
  const opened = [];
  const mux = idleMux({
    newWindow: async (session, cwd, spec) => {
      opened.push(spec.args[spec.args.indexOf('_run') + 2] ?? null);   // not meaningful, just an ordering token
      return { pane: `%${600 + opened.length}`, paneOwner: null };
    },
  });
  // Record dispatch order via the prompt text sent instead (unambiguous).
  const sentOrder = [];
  mux.sendText = async (pane, text) => sentOrder.push(text);

  await tickPromptQueue({ mux, now: Date.now() });

  assert.deepEqual(sentOrder, ['first', 'second', 'third']);
  const list = queueList();
  for (const id of [a.id, b.id, c.id]) {
    assert.equal(list.find(e => e.id === id).status, 'launching');
  }
});

test('tickPromptQueue: an unexpected newWindow rejection never propagates out of the tick', async () => {
  resetState();
  addEntry({ prompt: 'one' });
  addEntry({ prompt: 'two' });
  const mux = { name: 'tmux', newWindow: async () => { throw new Error('unexpected mux failure'); } };

  await assert.doesNotReject(tickPromptQueue({ mux, now: Date.now() }));

  const list = queueList();
  assert.ok(list.every(e => e.status === 'pending'));
  assert.ok(list.every(e => e.attempts === 1));
});

test('tickPromptQueue: an idle/empty queue never resolves or touches a multiplexer', async () => {
  resetState();
  let called = false;
  await tickPromptQueue({
    mux: new Proxy({}, { get() { called = true; return () => {}; } }),
    now: Date.now(),
  });
  assert.equal(called, false, 'an empty queue must never even look at the injected mux');
});

// --- regression: prompt-queue processing must never touch session records --

test('regression: tickPromptQueue never mutates unrelated session records', async () => {
  resetState();
  upsertSession({
    sessionId: '00000000-0000-4000-8000-000000000001',
    cwd: '/tmp/session-proj', pane: '%1', mux: 'tmux', paneOwner: null,
    muxSession: 'unsnooze-test', status: 'stopped', limitType: '5h', detectedVia: 'hook',
    detectedAt: Date.now(), resetAt: Date.now() + 3_600_000, resetSource: 'absolute',
    attempts: 0, lastAttemptAt: null, lastError: null,
  });
  const before = JSON.parse(JSON.stringify(readState().sessions));
  addEntry();
  const mux = { name: 'tmux', newWindow: async () => { throw new Error('fake failure'); } };
  await tickPromptQueue({ mux, now: Date.now() });
  assert.deepEqual(readState().sessions, before);
});

// --- resumer lifecycle: exit condition + tick wiring ------------------------

test('runResumer: empty queue and no sessions still exits immediately (unchanged)', async () => {
  resetState();
  const code = await runResumer({ resolveMux: () => ({}), pollInterval: 10 });
  assert.equal(code, 0);
});

test('runResumer: a pending queue entry with NO sessions keeps the loop alive until aborted', async () => {
  resetState();
  addEntry();
  const queueMux = { name: 'tmux', newWindow: async () => { throw new Error('no real window in tests'); } };
  const controller = new AbortController();
  let resolved = false;
  const done = runResumer({
    resolveMux: () => ({}),
    queueMux,
    pollInterval: 10,
    signal: controller.signal,
  }).then(code => { resolved = true; return code; });

  await sleep(120);
  assert.equal(resolved, false, 'a pending queue entry must keep a non-persistent resumer alive');
  controller.abort();
  const code = await done;
  assert.equal(code, 0);
});

test('runResumer: a delivered/terminal-only queue with no sessions exits (queue alone does not pin it forever)', async () => {
  resetState();
  const entry = addEntry();
  updateState(state => {
    state.promptQueue.find(e => e.id === entry.id).status = 'delivered';
    return state;
  });
  const code = await runResumer({ resolveMux: () => ({}), pollInterval: 10 });
  assert.equal(code, 0);
});
