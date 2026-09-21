// Persistent daemon mode: runResumer keeps running on an empty ledger, ticks
// the injected watcher every loop, and shuts down cleanly on abort.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-daemon-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';

const { runResumer } = await import('../src/resumer.js');
const { readState } = await import('../src/state.js');

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitUntil(cond, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(20);
  }
  return false;
}

test('non-persistent resumer still exits immediately on an empty ledger', async () => {
  const code = await runResumer({ resolveMux: () => ({ }), pollInterval: 10 });
  assert.equal(code, 0);
});

test('persistent daemon survives an empty ledger, ticks the watcher, stops on abort', async () => {
  let ticks = 0;
  const controller = new AbortController();
  const done = runResumer({
    resolveMux: () => ({ }),
    pollInterval: 10,
    persistent: true,
    watcher: { tick: async () => { ticks++; } },
    signal: controller.signal,
  });

  assert.ok(await waitUntil(() => ticks >= 3), 'watcher should tick repeatedly on an empty ledger');
  controller.abort();
  const code = await done;
  assert.equal(code, 0);
  // The singleton bookkeeping must be released after shutdown.
  assert.equal(readState().resumerPid, null);
});

test('daemon waiting on a foreign lock still ticks the watcher', async () => {
  // Another process (use our live parent pid) holds the resumer lock — the
  // daemon must keep watching for stops while it waits, or GUI stops that
  // happen during the wait age past the freshness window and are lost.
  writeFileSync(join(DIR, 'resumer.lock'), String(process.ppid));
  let ticks = 0;
  const controller = new AbortController();
  const done = runResumer({
    resolveMux: () => ({ }),
    pollInterval: 10,
    persistent: true,
    watcher: { tick: async () => { ticks++; } },
    signal: controller.signal,
  });
  assert.ok(await waitUntil(() => ticks >= 2), 'watcher must tick while the lock is held elsewhere');
  controller.abort();
  await done;
  rmSync(join(DIR, 'resumer.lock'), { force: true });
});

test('a watcher that throws does not kill the daemon', async () => {
  let calls = 0;
  const controller = new AbortController();
  const done = runResumer({
    resolveMux: () => ({ }),
    pollInterval: 10,
    persistent: true,
    watcher: { tick: async () => { calls++; throw new Error('boom'); } },
    signal: controller.signal,
  });
  assert.ok(await waitUntil(() => calls >= 2), 'daemon must keep ticking after a watcher error');
  controller.abort();
  await done;
});

// #25: every revival died with `spawn codex ENOENT`, and each attempt said so
// in lastError — until the last one, when giving up overwrote it with a bare
// "max resume attempts exceeded". That is the state the "gave up" notification
// sends the user to `unsnooze status` to read.
test('giving up keeps the last attempt\'s reason in lastError', async () => {
  const { upsertSession } = await import('../src/state.js');
  const { MAX_RESUME_ATTEMPTS } = await import('../src/config.js');
  const reason = 'revive died before it could resume (exit 127: unsnooze: failed to launch codex: spawn codex ENOENT)';
  const state = upsertSession({
    sessionId: '019f56fe-0000-4000-8000-00000000beef', cwd: '/tmp/proj-gave-up', agent: 'codex',
    mux: 'headless', pane: null, paneOwner: null, status: 'stopped', limitType: '5h',
    detectedVia: 'transcript', detectedAt: Date.now() - 3_600_000, resetAt: Date.now() - 1000,
    resetSource: 'absolute', attempts: MAX_RESUME_ATTEMPTS, lastError: reason,
  });
  const key = Object.values(state.sessions).find(s => s.cwd === '/tmp/proj-gave-up').key;
  assert.equal(await runResumer({ resolveMux: () => ({ }), pollInterval: 10 }), 0);
  const rec = readState().sessions[key];
  assert.equal(rec.status, 'failed');
  assert.match(rec.lastError, /max resume attempts exceeded/);
  assert.match(rec.lastError, /spawn codex ENOENT/);
});
