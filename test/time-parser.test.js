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

test('parses month-date weekly form "resets Jul 4 at 12:30am (Asia/Calcutta)"', () => {
  const p = parseResetTime("You've hit your weekly limit · resets Jul 4 at 12:30am (Asia/Calcutta)");
  assert.ok(p);
  assert.equal(p.month, 6);          // 0-indexed July
  assert.equal(p.dayOfMonth, 4);
  assert.equal(p.hour, 0);
  assert.equal(p.minute, 30);
  assert.equal(p.timezone, 'Asia/Calcutta');
  assert.equal(p.ambiguous, false);
});

test('month-date reset resolves to that date in the stated timezone', () => {
  const now = new Date('2026-07-01T12:00:00Z');
  const { at, source } = resetAtMs(parseResetTime('resets Jul 4 at 12:30am (Asia/Calcutta)'), { now, marginMs: MARGIN });
  assert.equal(source, 'absolute');
  // 00:30 IST on Jul 4 == 19:00 UTC on Jul 3
  assert.equal(at, new Date('2026-07-03T19:00:00Z').getTime() + MARGIN);
});

test('month-date day-walk across a DST fall-back stays on the named date', () => {
  // America/New_York falls back on 2026-11-01; the walk from Oct 30 to Nov 3
  // crosses it. Raw 24h steps would drift the wall clock and land on Nov 4.
  const now = new Date('2026-10-30T12:00:00-04:00');
  const { at, source } = resetAtMs(parseResetTime('resets Nov 3 at 12:30am (America/New_York)'), { now, marginMs: 0 });
  assert.equal(source, 'absolute');
  assert.equal(at, new Date('2026-11-03T05:30:00Z').getTime());   // 00:30 EST
});

test('month-date already past → fallback, never next year', () => {
  const now = new Date('2026-07-10T12:00:00Z');
  const { at, source } = resetAtMs(parseResetTime('resets Jul 4 at 12:30am (Asia/Calcutta)'), { now, fallbackMs: 5 * H, marginMs: MARGIN });
  assert.equal(source, 'fallback');
  assert.equal(at, now.getTime() + 5 * H + MARGIN);
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

// --- multi-unit relative forms from the 2026 adapters (agy / opencode) ---

test('parses agy "Refreshes in 6 days and 18 hours"', () => {
  const p = parseResetTime('Model quota limit exceeded. Refreshes in 6 days and 18 hours');
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, (6 * 24 + 18) * H);
});

test('parses opencode "It will reset in 2 hours 5 minutes"', () => {
  const p = parseResetTime('5 hour usage limit reached. It will reset in 2 hours 5 minutes.');
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, 2 * H + 5 * 60_000);
});

test('parses opencode Zen "Retry in 45 minutes."', () => {
  const p = parseResetTime('Subscription quota exceeded. Retry in 45 minutes.');
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, 45 * 60_000);
});

test('single-unit and colon forms still parse (regression)', () => {
  assert.equal(parseResetTime('resets in: 3 hours').waitMs, 3 * H);
  assert.equal(parseResetTime('try again in 5 minutes').waitMs, 5 * 60_000);
  assert.equal(parseResetTime('Try again in 4 days 20 hours 9 minutes.').waitMs, ((4 * 24 + 20) * 60 + 9) * 60_000);
});

// --- opencode status-line Go-durations: "[retrying in 2h5m attempt #4]" ---

test('parses compact Go-duration "[retrying in 2h5m attempt #4]"', () => {
  const p = parseResetTime('Rate Limited [retrying in 2h5m attempt #4]');
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, 2 * H + 5 * 60_000);
});

test('parses spaced Go-duration "[retrying in 2m 5s attempt #2]"', () => {
  const p = parseResetTime('Too Many Requests [retrying in 2m 5s attempt #2]');
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, 2 * 60_000 + 5_000);
});

test('parses approx Go-duration "[retrying in ~2 days attempt #9]"', () => {
  const p = parseResetTime('weekly usage limit reached [retrying in ~2 days attempt #9]');
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, 2 * 86_400_000);
});

test('bare "[retrying attempt #3]" (no duration) yields no parse', () => {
  assert.equal(parseResetTime('Rate Limited [retrying attempt #3]'), null);
});
