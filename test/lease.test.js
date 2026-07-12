import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-lease-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const {
  addressHash, createLeaseId, processBirth, writeLease, readLease,
  removeLease, leaseMatches,
} = await import('../src/lease.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

const address = { mux: 'zellij', paneOwner: 'main', pane: '1' };

test('address hash is stable and separates formerly-colliding addresses', () => {
  assert.equal(addressHash(address), addressHash({ ...address }));
  assert.notEqual(
    addressHash({ mux: 'zellij', paneOwner: 'foo-bar', pane: '1' }),
    addressHash({ mux: 'zellij', paneOwner: 'foo_bar', pane: '1' }),
  );
});

test('lease ids are random opaque values', () => {
  const a = createLeaseId();
  const b = createLeaseId();
  assert.match(a, /^[0-9a-f-]{20,}$/i);
  assert.notEqual(a, b);
});

test('processBirth parses Linux field 22 even when comm contains spaces', () => {
  const stat = `42 (agent process) ${['S', ...Array.from({ length: 18 }, (_, i) => i + 1), '987654'].join(' ')}`;
  assert.equal(processBirth(42, { platform: 'linux', readFile: () => stat }), '987654');
});

test('processBirth uses the portable macOS ps fallback and fails closed elsewhere', () => {
  assert.equal(processBirth(42, {
    platform: 'darwin', execFile: () => 'Thu Jun 25 20:44:37 2026\n',
  }), 'Thu Jun 25 20:44:37 2026');
  assert.equal(processBirth(42, { platform: 'plan9' }), null);
});

test('lease matching rejects mismatched leaseId, agent, pidBirth, PID reuse, and dead panes', async () => {
  const lease = { ...address, leaseId: createLeaseId(), agent: 'claude', pid: 42, pidBirth: 'born-a' };
  writeLease(lease);
  const mux = { paneAlive: async () => true };
  const options = { mux, pidAlive: () => true, processBirthFn: () => 'born-a' };
  assert.equal(await leaseMatches({ ...lease }, options), true);
  assert.equal(await leaseMatches({ ...lease, leaseId: 'other' }, options), false);
  assert.equal(await leaseMatches({ ...lease, agent: 'codex' }, options), false);
  assert.equal(await leaseMatches({ ...lease }, { ...options, processBirthFn: () => 'born-b' }), false);
  assert.equal(await leaseMatches({ ...lease }, { ...options, processBirthFn: () => null }), false);
  assert.equal(await leaseMatches({ ...lease }, { ...options, pidAlive: () => false }), false);
  assert.equal(await leaseMatches({ ...lease }, { ...options, mux: { paneAlive: async () => false } }), false);
});

test('compare-and-delete never removes a newer lease generation', () => {
  const oldLease = { ...address, leaseId: createLeaseId(), agent: 'claude', pid: 1, pidBirth: 'a' };
  const newLease = { ...address, leaseId: createLeaseId(), agent: 'claude', pid: 2, pidBirth: 'b' };
  writeLease(oldLease);
  writeLease(newLease);
  assert.equal(removeLease(address, oldLease.leaseId), true);
  assert.equal(readLease(address, newLease.leaseId).pid, 2);
  assert.equal(removeLease(address, oldLease.leaseId), false);
});

test('delayed lease publication changes a reopened record from unowned to owned', async () => {
  const rec = { ...address, leaseId: createLeaseId(), agent: 'claude' };
  const options = { mux: { paneAlive: async () => true }, pidAlive: () => true, processBirthFn: () => 'born' };
  assert.equal(await leaseMatches(rec, options), false);
  writeLease({ ...rec, pid: 77, pidBirth: 'born' });
  assert.equal(await leaseMatches(rec, options), true);
});
