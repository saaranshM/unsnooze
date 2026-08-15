// A banner scraped from pane history can be older than it looks.
//
// "resets 10:30pm" carries no date. Re-read at 00:30 it parses as *tomorrow*
// 10:30pm — 22 hours out — and the session sleeps through the reset it was
// waiting for. A 5h rolling window can never reset more than ~5h away, so a
// parse far beyond that is stale text and the wake belongs now.
//
// The boundary matters as much as the rule. resetAtMs pads an absolute reset
// with the margin, so judging the padded wake instead of the announced reset
// condemns legitimate resets near the edge of the window: with a 60-minute
// margin, a real 5h reset schedules 6h out and would be dragged back to
// one minute from now — the session woken hours early, into a live limit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveResetAt } from '../src/monitor.js';

const HOUR = 3_600_000;
const MARGIN = HOUR;                                   // deliberately large
const NOON = Date.UTC(2026, 7, 15, 12, 0, 0);
const HALF_PAST_MIDNIGHT = Date.UTC(2026, 7, 16, 0, 30, 0);

// Hours between detection and the scheduled wake.
function wakeIn(resetLine, { detectedAt = NOON, limitType = '5h', marginMs = MARGIN } = {}) {
  const { at, source } = resolveResetAt({
    resetLine, bannerAt: detectedAt, detectedAt, limitType, marginMs,
  });
  return { hours: (at - detectedAt) / HOUR, source };
}

test('a reset inside the window is scheduled at the announced time plus the margin', () => {
  const { hours, source } = wakeIn('resets 3pm (UTC)');       // 3h out at noon
  assert.equal(source, 'absolute');
  assert.equal(hours, 4, '3h reset + 1h margin');
});

test('a legitimate reset at the edge of the window is NOT clamped by its own margin', () => {
  // The review's case. 5h out with a 60-minute margin schedules 6h out, which
  // a naive "is the wake more than 5.5h away" test reads as stale.
  const { hours } = wakeIn('resets 5pm (UTC)');               // exactly 5h out
  assert.equal(hours, 6, 'the announced reset is what is judged, not the padded wake');
  assert.notEqual(hours, 1, 'must not collapse to due-now');
});

test('a stale undated banner — tomorrow, not tonight — is clamped to due now', () => {
  // 10:30pm read at 00:30 resolves to tonight's 10:30pm: 22 hours away, which
  // no 5h window can produce.
  const { hours } = wakeIn('resets 10:30pm (UTC)', { detectedAt: HALF_PAST_MIDNIGHT });
  assert.equal(hours, 1, 'wake now (margin only) — the announced reset has passed');
});

test('the boundary sits on the announced reset, not on the padded wake', () => {
  assert.equal(wakeIn('resets 5:24pm (UTC)').hours, 6.4, '5.4h out: inside the window, kept');
  assert.equal(wakeIn('resets 5:36pm (UTC)').hours, 1, '5.6h out: beyond it, clamped');
});

test('the same boundary holds with no margin at all', () => {
  assert.equal(wakeIn('resets 5pm (UTC)', { marginMs: 0 }).hours, 5, 'kept');
  assert.equal(wakeIn('resets 6pm (UTC)', { marginMs: 0 }).hours, 0, 'clamped to due-now');
});

test('only the 5h window is clamped — a weekly limit really can reset a day out', () => {
  const { hours } = wakeIn('resets 10:30pm (UTC)', {
    detectedAt: HALF_PAST_MIDNIGHT, limitType: 'weekly',
  });
  assert.equal(hours, 23, '22h + margin: ordinary for a weekly limit');
});

test('a relative reset is never clamped — "resets in 3 hours" cannot be stale text', () => {
  const { hours, source } = wakeIn('resets in 3 hours');
  assert.equal(source, 'relative');
  assert.equal(hours, 4);
});

test('an unparseable line falls back to probing rather than clamping', () => {
  assert.equal(wakeIn('resets sometime, who knows').source, 'fallback');
});
