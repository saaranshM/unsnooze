// Persistent daemon mode: runResumer keeps running on an empty ledger, ticks
// the injected watcher every loop, and shuts down cleanly on abort.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-daemon-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';

const { runResumer } = await import('../src/resumer.js');
const { readState } = await import('../src/state.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

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
  const code = await runResumer({ tmux: {}, pollInterval: 10 });
  assert.equal(code, 0);
});

test('persistent daemon survives an empty ledger, ticks the watcher, stops on abort', async () => {
  let ticks = 0;
  const controller = new AbortController();
  const done = runResumer({
    tmux: {},
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

test('a watcher that throws does not kill the daemon', async () => {
  let calls = 0;
  const controller = new AbortController();
  const done = runResumer({
    tmux: {},
    pollInterval: 10,
    persistent: true,
    watcher: { tick: async () => { calls++; throw new Error('boom'); } },
    signal: controller.signal,
  });
  assert.ok(await waitUntil(() => calls >= 2), 'daemon must keep ticking after a watcher error');
  controller.abort();
  await done;
});
