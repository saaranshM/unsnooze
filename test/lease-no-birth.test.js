// What ownership means on a host that cannot report process start times.
//
// The birth time is what makes a recycled pid detectable: same number, later
// start, different process. processBirth() reads /proc on linux and `ps` on
// darwin and returns null everywhere else — Windows, and any host where that
// call fails.
//
// Treating "this host cannot tell me" the same as "the process is an impostor"
// meant every ownership question answered "not ours", so unsnooze declined to
// resume its own sessions there — silently, forever. These pin the difference
// between unavailable and mismatched.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-lease-birth-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { writeLease, leaseMatches, paneOwnedByRecord } = await import('../src/lease.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

const alivePane = { paneAlive: async () => true };

function seed({ pane, pidBirth }) {
  const lease = {
    leaseId: `lease-${pane}`, mux: 'herdr', paneOwner: 'sess', pane,
    agent: 'claude', pid: process.pid, pidBirth,
  };
  writeLease(lease);
  return { leaseId: lease.leaseId, mux: 'herdr', paneOwner: 'sess', pane, agent: 'claude' };
}

test('matching birth times are ours', async () => {
  const rec = seed({ pane: 'w1:p1', pidBirth: 'THE-BIRTH' });
  assert.equal(await leaseMatches(rec, {
    mux: alivePane, pidAlive: () => true, processBirthFn: () => 'THE-BIRTH',
  }), true);
});

test('a changed birth time is a recycled pid, and is NOT ours', async () => {
  const rec = seed({ pane: 'w1:p2', pidBirth: 'THE-BIRTH' });
  assert.equal(await leaseMatches(rec, {
    mux: alivePane, pidAlive: () => true, processBirthFn: () => 'A-LATER-BIRTH',
  }), false);
});

test('a host that cannot report birth times still recognises its own lease', async () => {
  // Neither side has a birth time: the lease was written without one and the
  // host still cannot produce one. Everything else about the lease matched.
  const rec = seed({ pane: 'w1:p3', pidBirth: null });
  assert.equal(await leaseMatches(rec, {
    mux: alivePane, pidAlive: () => true, processBirthFn: () => null,
  }), true, 'this is the Windows case — refusing here means never resuming');
});

test('a lease with no birth time is still not ours once the host CAN report one', async () => {
  // The host gained the ability (or the lease predates a platform change):
  // we can no longer vouch for the pid, so fail closed.
  const rec = seed({ pane: 'w1:p4', pidBirth: null });
  assert.equal(await leaseMatches(rec, {
    mux: alivePane, pidAlive: () => true, processBirthFn: () => 'A-REAL-BIRTH',
  }), false);
});

test('a dead pid is never ours, birth times or not', async () => {
  const rec = seed({ pane: 'w1:p5', pidBirth: null });
  assert.equal(await leaseMatches(rec, {
    mux: alivePane, pidAlive: () => false, processBirthFn: () => null,
  }), false);
});

test('a pane stamp still outranks the lease entirely', async () => {
  const rec = seed({ pane: 'w1:p6', pidBirth: null });
  // A stamp naming a different lease means the pane id has been reused by a
  // later launch — that beats any amount of lease agreement.
  const stamped = { ...alivePane, paneOwnerStamp: async () => 'someone-elses-lease' };
  assert.equal(await paneOwnedByRecord(rec, { mux: stamped }), false);

  const ourStamp = { ...alivePane, paneOwnerStamp: async () => rec.leaseId };
  assert.equal(await paneOwnedByRecord(rec, { mux: ourStamp }), true);
});
