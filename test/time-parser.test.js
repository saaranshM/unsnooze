import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResetTime, resetAtMs } from '../src/time-parser.js';

const MARGIN = 60_000;
const H = 3_600_000;

test('parses absolute "resets 3pm (UTC)"', () => {
  const p = parseResetTime('· resets 3pm (UTC)');
  assert.deepEqual({ hour: p.hour, minute: p.minute, timezone: p.timezone }, { hour: 15, minute: 0, timezone: 'UTC' });
  assert.equal(p.ambiguous, false);
});

test('parses "resets at 3:30 PM"', () => {
  const p = parseResetTime('resets at 3:30 PM');
  assert.equal(p.hour, 15);
  assert.equal(p.minute, 30);
});

test('12am/12pm edge cases', () => {
  assert.equal(parseResetTime('resets 12am').hour, 0);
  assert.equal(parseResetTime('resets 12pm').hour, 12);
});

test('parses relative "try again in 5 minutes"', () => {
  const p = parseResetTime('try again in 5 minutes');
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, 5 * 60_000);
});

test('parses "resets in: 3 hours"', () => {
  const p = parseResetTime('resets in: 3 hours');
  assert.equal(p.waitMs, 3 * H);
});

test('unparseable → null → fallback used', () => {
  assert.equal(parseResetTime('garbage text'), null);
  const now = new Date('2026-07-05T12:00:00Z');
  const { at, source } = resetAtMs(null, { now, fallbackMs: 5 * H, marginMs: MARGIN });
  assert.equal(at, now.getTime() + 5 * H + MARGIN);
  assert.equal(source, 'fallback');
});

test('absolute UTC time in the future today', () => {
  const now = new Date('2026-07-05T12:00:00Z');
  const { at } = resetAtMs(parseResetTime('resets 3pm (UTC)'), { now, marginMs: MARGIN });
  assert.equal(at, new Date('2026-07-05T15:00:00Z').getTime() + MARGIN);
});

test('absolute UTC time already past → tomorrow', () => {
  const now = new Date('2026-07-05T18:00:00Z');
  const { at } = resetAtMs(parseResetTime('resets 3pm (UTC)'), { now, marginMs: MARGIN });
  assert.equal(at, new Date('2026-07-06T15:00:00Z').getTime() + MARGIN);
});

test('ambiguous hour picks nearest future occurrence', () => {
  const now = new Date('2026-07-05T12:00:00Z');
  // "resets 3" (no am/pm) in UTC: 3am tomorrow (15h away) vs 3pm today (3h away) → 3pm today
  const p = parseResetTime('resets 3 (UTC)');
  assert.equal(p.ambiguous, true);
  const { at } = resetAtMs(p, { now, marginMs: MARGIN });
  assert.equal(at, new Date('2026-07-05T15:00:00Z').getTime() + MARGIN);
});

test('DST boundary: America/New_York spring forward', () => {
  // 2026-03-08 02:00 EST → EDT. Ask for "resets 3pm" the day of.
  const now = new Date('2026-03-08T13:00:00Z'); // 8am EST→EDT morning
  const { at } = resetAtMs(parseResetTime('resets 3pm (America/New_York)'), { now, marginMs: 0 });
  // 3pm EDT = 19:00 UTC
  assert.equal(at, new Date('2026-03-08T19:00:00Z').getTime());
});

test('weekly: "resets Tuesday 9am (UTC)" rolls to next Tuesday', () => {
  const now = new Date('2026-07-05T12:00:00Z'); // a Sunday
  const p = parseResetTime('· resets Tuesday 9am (UTC)');
  assert.equal(p.day, 2);
  const { at } = resetAtMs(p, { now, marginMs: 0 });
  assert.equal(at, new Date('2026-07-07T09:00:00Z').getTime());
});

test('invalid timezone falls back', () => {
  const now = new Date('2026-07-05T12:00:00Z');
  const { at, source } = resetAtMs(
    { hour: 15, minute: 0, timezone: 'Not/AZone', ambiguous: false, day: null },
    { now, fallbackMs: 5 * H, marginMs: MARGIN },
  );
  assert.equal(source, 'fallback');
  assert.equal(at, now.getTime() + 5 * H + MARGIN);
});
