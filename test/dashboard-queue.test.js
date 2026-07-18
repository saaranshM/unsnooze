// loadStatusSnapshot's promptQueue field — kept in its own file (rather than
// dashboard.test.js) because state.js/config.js resolve UNSNOOZE_STATE_DIR
// at import time, and dashboard.test.js already statically imports data.js
// (and transitively state.js) before any test-local code can run — setting
// the env var after that would be too late and risk touching the real
// ~/.unsnooze. This file sets it first, before any src import, per the
// convention in test/prompt-queue.test.js.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-dashboard-queue-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { updateState } = await import('../src/state.js');
const { loadStatusSnapshot } = await import('../src/dashboard/data.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

test('loadStatusSnapshot returns promptQueue from queueList()', () => {
  updateState(state => {
    state.promptQueue.push(
      { id: 'p-1', cwd: '/w', agent: 'claude', prompt: 'go', mode: 'now', atMs: null,
        notBefore: 0, createdAt: 100, createdBy: 'local', status: 'pending', attempts: 0,
        lastError: null, deliveredAt: null, sentAt: null, pane: null, muxSession: null, leaseId: null },
      { id: 'p-2', cwd: '/w', agent: 'claude', prompt: 'go2', mode: 'now', atMs: null,
        notBefore: 0, createdAt: 50, createdBy: 'local', status: 'pending', attempts: 0,
        lastError: null, deliveredAt: null, sentAt: null, pane: null, muxSession: null, leaseId: null },
    );
    return state;
  });

  const snap = loadStatusSnapshot();
  assert.ok(Array.isArray(snap.promptQueue));
  assert.equal(snap.promptQueue.length, 2);
  // queueList() sorts FIFO by createdAt — p-2 (50) before p-1 (100).
  assert.deepEqual(snap.promptQueue.map(e => e.id), ['p-2', 'p-1']);
});
