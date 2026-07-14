import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResetTime, resetAtMs, nextProbeDelayMs, sourceRank } from '../src/time-parser.js';

const MARGIN = 60_000;
const H = 3_600_000;
const PROBE = 15 * 60_000;

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

test('parses "try again in 0 minutes" as already-elapsed (not a fallback miss)', () => {
  // e2e + real "limit just lifted" banners; must not fall through to probe/5h.
  const p = parseResetTime("You've hit your session limit · try again in 0 minutes");
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, 0);
  const { at, source } = resetAtMs(p, { now: new Date(1_000_000), marginMs: MARGIN });
  assert.equal(source, 'relative');
  assert.equal(at, 1_000_000 + MARGIN);
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
  const { at, source } = resetAtMs(parseResetTime('resets Jul 4 at 12:30am (Asia/Calcutta)'), { now, fallbackMs: PROBE, marginMs: MARGIN });
  assert.equal(source, 'fallback');
  assert.equal(at, now.getTime() + PROBE + MARGIN);
});

test('unparseable → null → probe-interval fallback (not 5h)', () => {
  assert.equal(parseResetTime('garbage text'), null);
  const now = new Date('2026-07-05T12:00:00Z');
  const { at, source } = resetAtMs(null, { now, fallbackMs: PROBE, marginMs: MARGIN });
  assert.equal(at, now.getTime() + PROBE + MARGIN);
  assert.equal(source, 'fallback');
});

test('absolute UTC time in the future today', () => {
  const now = new Date('2026-07-05T12:00:00Z');
  const { at } = resetAtMs(parseResetTime('resets 3pm (UTC)'), { now, marginMs: MARGIN });
  assert.equal(at, new Date('2026-07-05T15:00:00Z').getTime() + MARGIN);
});

// §3 deliberate correction: already-past absolute time is DUE NOW, not +24h.
// (Previously this test pinned the +24h rollover as intended — that was the bug.)
test('absolute UTC time already past → due now, not tomorrow', () => {
  const now = new Date('2026-07-05T18:00:00Z');
  const { at, source } = resetAtMs(parseResetTime('resets 3pm (UTC)'), { now, marginMs: MARGIN });
  assert.equal(source, 'absolute');
  assert.equal(at, now.getTime() + MARGIN);
});

test('stale absolute banner: next occurrence after bannerAt, past wall-clock → due now', () => {
  // Banner said 10:40pm IST at banner time; scraped hours later after reset.
  // 10:40pm Asia/Calcutta = 17:10 UTC.
  const bannerAt = new Date('2026-07-05T14:00:00Z').getTime(); // 7:30pm IST
  const now = new Date('2026-07-05T18:00:00Z');                 // 11:30pm IST — past 10:40pm
  const p = parseResetTime("You've hit your session limit · resets 10:40pm (Asia/Calcutta)");
  const { at, source } = resetAtMs(p, { now, bannerAt, marginMs: MARGIN });
  assert.equal(source, 'absolute');
  // Resolved 10:40pm IST after banner (= 17:10 UTC) is past wall now → due now
  assert.equal(at, now.getTime() + MARGIN);
});

test('real fixture: session limit · resets 10:40pm (Asia/Calcutta) anchors to banner time', () => {
  // Replay-style: entry timestamp 2026-07-05T14:00:00Z, reset 10:40pm IST same day.
  // 10:40pm Asia/Calcutta = 17:10 UTC. Banner is before that → future reset.
  const bannerAt = new Date('2026-07-05T14:00:00Z').getTime();
  const now = new Date('2026-07-05T14:05:00Z'); // scrape ~5 min later
  const p = parseResetTime("You've hit your session limit · resets 10:40pm (Asia/Calcutta)");
  assert.ok(p);
  assert.equal(p.hour, 22);
  assert.equal(p.minute, 40);
  assert.equal(p.timezone, 'Asia/Calcutta');
  const { at, source } = resetAtMs(p, { now, bannerAt, marginMs: MARGIN });
  assert.equal(source, 'absolute');
  const expected = new Date('2026-07-05T17:10:00Z').getTime() + MARGIN;
  assert.equal(at, expected);
  // Must NOT be +5h from scrape and NOT +24h
  assert.notEqual(at, now.getTime() + 5 * H + MARGIN);
  assert.notEqual(at, expected + 86_400_000);
});

test('stale relative banner: printed at T0, scraped at T0+2h ⇒ reset = T0+offset', () => {
  const bannerAt = new Date('2026-07-05T10:00:00Z').getTime();
  const now = new Date('2026-07-05T12:00:00Z'); // +2h
  const p = parseResetTime('resets in 3 hours');
  const { at, source } = resetAtMs(p, { now, bannerAt, marginMs: MARGIN });
  assert.equal(source, 'relative');
  assert.equal(at, bannerAt + 3 * H + MARGIN);
  // Not scrape+offset
  assert.notEqual(at, now.getTime() + 3 * H + MARGIN);
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
    { now, fallbackMs: PROBE, marginMs: MARGIN },
  );
  assert.equal(source, 'fallback');
  assert.equal(at, now.getTime() + PROBE + MARGIN);
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

// --- §5 compact multi-unit: "1h 30m" must sum both tokens ---

test('parses compact "resets in 1h 30m" as 1h30m not 1h', () => {
  const p = parseResetTime('resets in 1h 30m');
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, 1 * H + 30 * 60_000); // 5_400_000
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

test('nextProbeDelayMs backs off 15→30→60 and caps', () => {
  assert.equal(nextProbeDelayMs(0, { intervalMs: PROBE, maxMs: 60 * 60_000 }), PROBE);
  assert.equal(nextProbeDelayMs(1, { intervalMs: PROBE, maxMs: 60 * 60_000 }), 30 * 60_000);
  assert.equal(nextProbeDelayMs(2, { intervalMs: PROBE, maxMs: 60 * 60_000 }), 60 * 60_000);
  assert.equal(nextProbeDelayMs(5, { intervalMs: PROBE, maxMs: 60 * 60_000 }), 60 * 60_000);
});

test('sourceRank orders absolute > relative > fallback', () => {
  assert.ok(sourceRank('absolute') > sourceRank('relative'));
  assert.ok(sourceRank('relative') > sourceRank('fallback'));
});
