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
  queueAdd, queueList, queueRemove, dispatchPromptEntry, verifyPromptEntry, tickPromptQueue,
} = await import('../src/prompt-queue.js');
const { runResumer, retryBackoffMs } = await import('../src/resumer.js');
const { RESUME_SESSION_NAME, VERIFY_DELAY_MS, MAX_RESUME_ATTEMPTS, RESET_MARGIN_MS, PROBE_INTERVAL_MS, READY_TIMEOUT_MS } = await import('../src/config.js');
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
  // Real send time (Date.now() when awaitReadyAndSend actually resolves
  // 'sent'), not the tick-start `now` passed in — its poll loop spends real
  // time waiting for the pane to go idle first.
  assert.ok(updated.sentAt >= now, 'sentAt must not predate dispatch start');
  assert.deepEqual(sent, [{ pane: '%501', text: 'do the thing' }]);

  // Not yet due for verification.
  const tooSoon = await verifyPromptEntry(updated, { mux, now: updated.sentAt + 1 });
  assert.equal(tooSoon.status, 'launching');

  // Later verify (inject now past VERIFY_DELAY_MS measured from the REAL
  // sentAt) → delivered.
  const verified = await verifyPromptEntry(updated, { mux, now: updated.sentAt + VERIFY_DELAY_MS + 1000 });
  assert.equal(verified.status, 'delivered');
  assert.equal(verified.deliveredAt, updated.sentAt + VERIFY_DELAY_MS + 1000);
  assert.equal(verified.lastError, null);
});

test('verifyPromptEntry: pane unreadable (window closed) counts as delivered-unverifiable', async () => {
  resetState();
  const entry = addEntry();
  const mux = idleMux();
  const now = Date.now();
  const dispatched = await dispatchPromptEntry(entry, { mux, now });
  const closedMux = { ...mux, capturePane: async () => { throw new Error('no such pane'); } };
  const verified = await verifyPromptEntry(dispatched, { mux: closedMux, now: dispatched.sentAt + VERIFY_DELAY_MS + 1 });
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

test('dispatchPromptEntry: cancelled mid-dispatch-poll → stays cancelled, never resurrected, no delivered/failed notify', async () => {
  resetState();
  const entry = addEntry();
  const resetLine = '· resets 3:30pm (UTC)';
  const bannerText = `⚠ You've hit your 5-hour limit\n${resetLine}\n> `;
  // capturePane is the seam awaitReadyAndSend's poll loop uses — cancel the
  // entry (as if the dashboard's 'x'/'d' + 'y' confirm ran concurrently)
  // right as the fresh pane comes up against a limit banner.
  const mux = idleMux({
    capturePane: async () => { queueRemove(entry.id); return bannerText; },
  });
  const toasts = [];
  const now = Date.now();
  const updated = await dispatchPromptEntry(entry, {
    mux, now, notifier: (title, message, opts) => toasts.push({ title, message, opts }),
  });

  assert.equal(updated.status, 'cancelled', 'a cancel that lands mid-poll must win — never resurrected to pending');
  assert.equal(toasts.length, 0, 'a CAS loss must never fire a delivered/failed notification');
  assert.equal(queueList().find(e => e.id === entry.id).status, 'cancelled');
});

test('dispatchPromptEntry: "sent" outcome leaves the fresh pane open (nothing to verify from otherwise)', async () => {
  resetState();
  const entry = addEntry();
  let closed = null;
  const mux = idleMux({ closePane: async (pane) => { closed = pane; } });
  const now = Date.now();
  const updated = await dispatchPromptEntry(entry, { mux, now });

  assert.equal(updated.status, 'launching');
  assert.equal(closed, null, 'a successfully sent prompt must not close its own pane');
});

test('dispatchPromptEntry: "limit" outcome kills the abandoned window (best-effort)', async () => {
  resetState();
  const entry = addEntry();
  let closed = null;
  const resetLine = '· resets 3:30pm (UTC)';
  const bannerText = `⚠ You've hit your 5-hour limit\n${resetLine}\n> `;
  const mux = idleMux({
    capturePane: async () => bannerText,
    closePane: async (pane) => { closed = pane; },
  });
  const now = Date.now();
  const updated = await dispatchPromptEntry(entry, { mux, now });

  assert.equal(updated.status, 'pending');
  assert.equal(closed, '%501', 'the just-opened pane must be closed so no phantom monitor picks it up later');
});

test('dispatchPromptEntry: "timeout" outcome kills the abandoned window too', async () => {
  resetState();
  const entry = addEntry();
  let closed = null;
  const mux = idleMux({
    capturePane: async () => '✻ Cogitating… (esc to interrupt)',
    closePane: async (pane) => { closed = pane; },
  });
  const now = Date.now();
  const updated = await dispatchPromptEntry(entry, { mux, now, readyTimeoutMs: 50 });

  assert.equal(updated.status, 'pending');
  assert.equal(closed, '%501');
});

test('dispatchPromptEntry: closePane absence on the mux is tolerated (best-effort, not required)', async () => {
  resetState();
  const entry = addEntry();
  const resetLine = '· resets 3:30pm (UTC)';
  const bannerText = `⚠ You've hit your 5-hour limit\n${resetLine}\n> `;
  const mux = idleMux({ capturePane: async () => bannerText });   // no closePane at all
  const now = Date.now();
  const updated = await dispatchPromptEntry(entry, { mux, now });

  assert.equal(updated.status, 'pending');
});

// --- tickPromptQueue: stranded-launch recovery ------------------------------

test('tickPromptQueue: crash-stranded launching entry (no sentAt, launchedAt long past) recovers to pending', async () => {
  resetState();
  // mode 'at' far in the future so, once reclaimed to 'pending', it is not
  // itself due — keeps this test to the pure recovery behavior without also
  // exercising a redispatch through the mux.
  const entry = addEntry({ mode: 'at', atMs: Date.now() + 999_999_999 });
  const staleLaunchedAt = Date.now() - (READY_TIMEOUT_MS + 30_000 + 1);
  updateState(state => {
    const e = state.promptQueue.find(x => x.id === entry.id);
    e.status = 'launching';
    e.sentAt = null;
    e.launchedAt = staleLaunchedAt;
    e.pane = '%777';
    return state;
  });

  let muxTouched = false;
  const trapMux = new Proxy({ name: 'tmux' }, {
    get(target, prop) {
      if (prop === 'name') return 'tmux';
      muxTouched = true;
      return () => {};
    },
  });

  await tickPromptQueue({ mux: trapMux, now: Date.now() });

  const after = queueList().find(e => e.id === entry.id);
  assert.equal(after.status, 'pending');
  assert.equal(after.attempts, 1);
  assert.equal(after.lastError, 'stranded launch');
  assert.equal(muxTouched, false, 'recovery is pure state — a not-yet-due reclaimed entry must never touch the mux');
});

test('tickPromptQueue: a "launching" entry that already has sentAt is left to verifyPromptEntry, not swept as stranded', async () => {
  resetState();
  const entry = addEntry();
  const staleLaunchedAt = Date.now() - (READY_TIMEOUT_MS + 60_000);
  updateState(state => {
    const e = state.promptQueue.find(x => x.id === entry.id);
    e.status = 'launching';
    e.sentAt = Date.now() - VERIFY_DELAY_MS - 1000;   // already sent, past verify delay
    e.launchedAt = staleLaunchedAt;
    e.pane = '%778';
    return state;
  });
  const mux = idleMux();

  await tickPromptQueue({ mux, now: Date.now() });

  const after = queueList().find(e => e.id === entry.id);
  assert.equal(after.status, 'delivered', 'a sent entry must go through verify, never get reclassified as a stranded launch');
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
