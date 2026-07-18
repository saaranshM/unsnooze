// Parse reset banner text (Claude Code or Codex CLI) into an absolute
// epoch-ms reset time. DST-safe: resolves "resets 3pm (UTC)" via iterative
// correction in the stated timezone rather than naive offset math.

// Optional weekday between "resets" and the time covers weekly banners
// ("resets Tuesday 9am (UTC)").
const RESET_TIME_REGEX = /resets?\s+(?:at\s+)?(?:on\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;
// "resets Tuesday 3pm" / "resets on Mon" — weekly limits carry a day name.
const DAY_REGEX = /resets?\s+(?:on\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*/i;
const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// Undated past clock times may roll +24h only when tomorrow's occurrence is
// within this lead — the longest bare-clock announcement a limit window makes
// (5h) plus slack. Anything further past is stale text, kept past → due-now.
const MIDNIGHT_ROLL_MAX_MS = 6 * 3_600_000;
// Month-date weekly form (transcript/API error text):
//   "resets Jul 4 at 12:30am (Asia/Calcutta)"
const RESET_DATE_REGEX = /resets?\s+(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+\d{4})?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;

// Codex CLI forms ("try again at …", local time):
//   same day:  "or try again at 3:51 PM."
//   cross-day: "or try again at Feb 23rd, 2026 9:01 PM."
//   older:     "Try again in 4 days 20 hours 9 minutes."
const TRY_AT_TIME_REGEX = /try again at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
const TRY_AT_DATE_REGEX = /try again at\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i;
// Relative "in …" clause — word forms and compact Go-style ("1h 30m", "2h5m").
// Capture the duration phrase and sum every token via parseGoDuration.
const RELATIVE_IN_REGEX = /(?:try again|resets?|refreshes|retry|wait)\s+in[:\s]+(.+?)(?:\.\s|\.\s*$|attempt\s*#?\d+|$)/i;
// "wait 5 minutes" / "wait for 5 minutes" without a leading "in".
const WAIT_DURATION_REGEX = /\bwait\s+(?:for\s+)?(?!in\b)(?=~?\s*\d)(.+?)(?:\.\s|\.\s*$|$)/i;
// opencode status line: "Rate Limited [retrying in 2h5m attempt #4]" — the
// duration is Go-style ("2h5m", "2m 5s", "~2 days").
const RETRY_BANNER_REGEX = /retrying in\s+([^\]\n]*?)\s*attempt\s*#?\d+/i;
// (?![a-z]) instead of \b: compact Go durations pack units against the next
// digit ("2h5m"), where h→5 is not a word boundary.
const DURATION_TOKEN_REGEX = /~?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|seconds?|secs?|s|min(?:ute)?s?|m|hours?|hrs?|h|days?|d|weeks?|w)(?![a-z])/gi;
const DURATION_UNIT_MS = {
  ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
  millisecond: 1, second: 1000, sec: 1000, min: 60_000, minute: 60_000,
  hour: 3_600_000, hr: 3_600_000, day: 86_400_000, week: 604_800_000,
};

// Exported so callers that accept the same "+2h30m" / "45m" token grammar
// (e.g. prompt.js's --at parser) don't have to duplicate DURATION_TOKEN_REGEX.
export function parseGoDuration(text) {
  let total = 0;
  // Reset lastIndex — the regex is global and shared across calls.
  DURATION_TOKEN_REGEX.lastIndex = 0;
  for (const m of text.matchAll(DURATION_TOKEN_REGEX)) {
    const raw = m[2].toLowerCase();
    // Exact form first ("ms" must not singular-strip to "m"), then singular.
    const perUnit = DURATION_UNIT_MS[raw] ?? DURATION_UNIT_MS[raw.replace(/s$/, '')];
    if (perUnit) total += parseFloat(m[1]) * perUnit;
  }
  return total;
}

// Parse a captured duration phrase. Returns waitMs (including 0 for "0 minutes")
// or null when the phrase has no duration tokens. Explicit zero is a real,
// already-elapsed wait — the e2e path and "try again in 0 minutes" banners
// depend on this not falling through to the blind fallback.
function parseDurationPhrase(phrase) {
  if (!phrase || !/\d/.test(phrase)) return null;
  DURATION_TOKEN_REGEX.lastIndex = 0;
  if (!DURATION_TOKEN_REGEX.test(phrase)) return null;
  return parseGoDuration(phrase);
}
const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function to24h(hour, ampm) {
  let h = hour;
  if (ampm === 'pm' && h !== 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return h;
}

// A mangled banner can regex-match a nonsense clock ("resets 45:99"); letting
// it through builds an Invalid Date whose Intl formatting throws RangeError.
// Reject at parse time so callers degrade to the probe/fallback ladder.
function validClock(hour, minute) {
  return Number.isFinite(hour) && hour >= 0 && hour <= 23
    && Number.isFinite(minute) && minute >= 0 && minute <= 59;
}

function toMs(t) {
  if (t instanceof Date) return t.getTime();
  return Number(t);
}

export function parseResetTime(text) {
  if (!text) return null;

  // Self-retry countdown banner first (opencode) — the bracketed duration is
  // the live countdown and beats any older prose in the same line.
  const retryMatch = text.match(RETRY_BANNER_REGEX);
  if (retryMatch) {
    const waitMs = parseDurationPhrase(retryMatch[1]);
    if (waitMs != null) return { relative: true, waitMs };
  }

  // Full-date form first — its trailing "9:01 PM" would otherwise be eaten by
  // the same-day "try again at" regex.
  const dateMatch = text.match(TRY_AT_DATE_REGEX);
  if (dateMatch) {
    const [, mon, day, year, hour, minute, ampm] = dateMatch;
    const atMs = new Date(
      parseInt(year, 10), MONTH_INDEX[mon.toLowerCase()], parseInt(day, 10),
      to24h(parseInt(hour, 10), ampm.toLowerCase()), parseInt(minute, 10),
    ).getTime();
    return { absolute: true, atMs };
  }

  const tryAtMatch = text.match(TRY_AT_TIME_REGEX);
  if (tryAtMatch) {
    const hour = to24h(parseInt(tryAtMatch[1], 10), tryAtMatch[3].toLowerCase());
    const minute = tryAtMatch[2] ? parseInt(tryAtMatch[2], 10) : 0;
    if (!validClock(hour, minute)) return null;
    return { hour, minute, timezone: null, ambiguous: false, day: null };
  }

  const resetDateMatch = text.match(RESET_DATE_REGEX);
  if (resetDateMatch) {
    const [, mon, dayOfMonth, hourRaw, minuteRaw, ampmRaw, timezone] = resetDateMatch;
    const ampm = ampmRaw?.toLowerCase() || null;
    let hour = parseInt(hourRaw, 10);
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    const minute = minuteRaw ? parseInt(minuteRaw, 10) : 0;
    if (!validClock(hour, minute)) return null;
    return {
      month: MONTH_INDEX[mon.toLowerCase()],
      dayOfMonth: parseInt(dayOfMonth, 10),
      hour,
      minute,
      timezone: timezone || null,
      ambiguous: !ampm && hour >= 1 && hour <= 12,
      day: null,
    };
  }

  const dayMatch = text.match(DAY_REGEX);
  const absMatch = text.match(RESET_TIME_REGEX);
  if (absMatch) {
    let hour = parseInt(absMatch[1], 10);
    const minute = absMatch[2] ? parseInt(absMatch[2], 10) : 0;
    const ampm = absMatch[3]?.toLowerCase() || null;
    const timezone = absMatch[4] || null;

    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;

    const ambiguous = !ampm && hour >= 1 && hour <= 12;
    if (!validClock(hour, minute)) return null;
    return {
      hour, minute, timezone, ambiguous,
      day: dayMatch ? DAY_INDEX[dayMatch[1].toLowerCase()] : null,
    };
  }

  // Relative offsets: sum every duration token so "1h 30m" / "2 hours 5 minutes"
  // / "6 days and 18 hours" all land at the full wait, not the first unit.
  // "0 minutes" is intentional (already elapsed) — not a miss.
  const inMatch = text.match(RELATIVE_IN_REGEX);
  if (inMatch) {
    const waitMs = parseDurationPhrase(inMatch[1]);
    if (waitMs != null) return { relative: true, waitMs };
  }
  const waitMatch = text.match(WAIT_DURATION_REGEX);
  if (waitMatch) {
    const waitMs = parseDurationPhrase(waitMatch[1]);
    if (waitMs != null) return { relative: true, waitMs };
  }

  // Day-only weekly banner ("resets Tuesday") with no time — midnight-ish target,
  // resolved by resetAtMs via hour 0.
  if (dayMatch) {
    return { hour: 0, minute: 0, timezone: null, ambiguous: false, day: DAY_INDEX[dayMatch[1].toLowerCase()] };
  }

  return null;
}

// Convert parsed reset info into an absolute epoch ms (includes margin).
//
// `now`     — wall-clock reference (is the reset already past?).
// `bannerAt`— when the banner text was produced. Relative offsets and
//             next-occurrence math anchor here so a stale scrape doesn't
//             re-add the full wait. Falls back to `now` when unknown.
// Unparseable input falls back to now + fallbackMs (callers pass a short
// probe interval, not a multi-hour guess).
export function resetAtMs(parsed, {
  marginMs = 60_000,
  fallbackMs = 5 * 3_600_000,
  now = new Date(),
  bannerAt = null,
} = {}) {
  const wallNow = toMs(now);
  const anchor = bannerAt != null ? toMs(bannerAt) : wallNow;
  // Absolute next-occurrence math uses an anchor Date so targetTimestamp's
  // formatToParts sees the banner's local day, not today's.
  const anchorDate = new Date(anchor);

  const source = !parsed ? 'fallback' : parsed.relative ? 'relative' : 'absolute';
  if (!parsed) return { at: wallNow + fallbackMs + marginMs, source };
  if (parsed.relative) return { at: anchor + parsed.waitMs + marginMs, source };
  // Pre-resolved epoch (full-date banner, local time). A stale past date means
  // we misread the banner — fall back rather than firing immediately.
  if (parsed.absolute) {
    if (parsed.atMs <= wallNow) return { at: wallNow + fallbackMs + marginMs, source: 'fallback' };
    return { at: parsed.atMs + marginMs, source };
  }

  let tz;
  try {
    tz = parsed.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return { at: wallNow + fallbackMs + marginMs, source: 'fallback' };
  }

  // DST-safe: build today's date in the target tz, then iteratively correct the
  // UTC guess until it formats as the desired local h:m. Correction normalized
  // to [-720, +720] minutes to take the minimum-magnitude step (avoids the
  // off-by-a-day bug in high-offset timezones).
  function correctWallClock(candidate, h, m) {
    for (let i = 0; i < 3; i++) {
      const fp = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
      }).formatToParts(new Date(candidate));
      const ch = parseInt(fp.find(p => p.type === 'hour').value) % 24;
      const cm = parseInt(fp.find(p => p.type === 'minute').value);
      let diffMin = (h - ch) * 60 + (m - cm);
      diffMin = ((diffMin % 1440) + 1440) % 1440;
      if (diffMin > 720) diffMin -= 1440;
      if (diffMin === 0) break;
      candidate += diffMin * 60_000;
    }
    return candidate;
  }

  // Resolve h:m on the local calendar day of `ref` (banner time or wall clock).
  function targetTimestamp(h, m, ref = anchorDate) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour12: false,
    }).formatToParts(ref);
    const y = parseInt(parts.find(p => p.type === 'year').value);
    const mo = parseInt(parts.find(p => p.type === 'month').value);
    const d = parseInt(parts.find(p => p.type === 'day').value);

    const targetStr = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    return correctWallClock(new Date(targetStr + 'Z').getTime(), h, m);
  }

  // Occurrence of h:m relative to the banner's calendar day.
  // - If that wall-clock is still after the banner, use it (may already be
  //   past wall-clock `now` — caller treats that as "already reset").
  // - If the banner was printed at/after that clock time, roll +1 day
  //   (the announcement means tomorrow). Undated scrapes (bannerAt unknown,
  //   so anchor === wallNow) leave a past-on-day time past so we due-now
  //   instead of the old blind +24h rollover.
  // Weekday forms always roll forward to the named day in the future.
  function nextOccurrence(h, m) {
    let t = targetTimestamp(h, m, anchorDate);
    if (parsed.day != null) {
      // Roll the REFERENCE day forward and re-derive h:m for each candidate
      // day: stepping the timestamp itself by fixed 24h units drifts by ±1h
      // when the roll crosses a DST boundary (observed: "resets Tuesday 9am"
      // landing at 10am after a spring-forward weekend).
      const weekdayOf = ts => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
        .format(new Date(ts)).toLowerCase().slice(0, 3);
      let ref = anchor;
      for (let i = 0; i < 9; i++) {
        const candidate = targetTimestamp(h, m, new Date(ref));
        if (DAY_INDEX[weekdayOf(candidate)] === parsed.day && candidate > anchor) {
          return candidate;
        }
        ref += 86_400_000;
      }
      return t;   // unreachable in practice — 9 steps cover a week + DST repeat
    }
    if (t <= anchor) {
      // Dated banner, or ambiguous (need both am/pm candidates as real
      // next-occurrences): roll to the next day. Undated non-ambiguous
      // past clock times stay past so the outer guard returns due-now
      // instead of a blind +24h.
      if (bannerAt != null || parsed.ambiguous) t += 86_400_000;
      // Midnight cross on an undated live scrape: "resets 12:04am" seen at
      // 9pm parses ~21h past. A limit banner only announces times inside its
      // own window, so when tomorrow's occurrence is within that short lead
      // it IS tomorrow — a stale banner rolled here would have to be ≥18h
      // old, far beyond any window. Leaving it past would fire a due-now
      // resume straight into a still-live limit.
      else if (t + 86_400_000 - anchor <= MIDNIGHT_ROLL_MAX_MS) t += 86_400_000;
    }
    return t;
  }

  // Month-date form ("resets Jul 4 at 12:30am (tz)"): roll forward from the
  // banner's local day in the target tz to the named month/day, re-correct the
  // wall-clock (the walk may cross DST). An already-past date means we misread
  // stale text — fall back rather than waiting toward next year.
  if (parsed.month != null) {
    const monthDayAt = t => {
      const fp = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'numeric', day: 'numeric' })
        .formatToParts(new Date(t));
      return [
        parseInt(fp.find(p => p.type === 'month').value, 10) - 1,
        parseInt(fp.find(p => p.type === 'day').value, 10),
      ];
    };
    const resolve = (h, m) => {
      // Re-correct the wall clock on EVERY day step: a raw 24h jump across a
      // DST transition drifts the local time, and a drifted probe can match
      // the named date at the wrong instant (landing a day late after the
      // final correction). The walk is capped just past the 10-day acceptance
      // window below — longer walks are discarded anyway.
      let t = targetTimestamp(h, m, anchorDate);
      for (let i = 0; i <= 12; i++) {
        const [mo, d] = monthDayAt(t);
        if (mo === parsed.month && d === parsed.dayOfMonth) return t;
        t = correctWallClock(t + 86_400_000, h, m);
      }
      return null;   // beyond the weekly window (or an impossible date)
    };
    const candidates = parsed.ambiguous
      ? [resolve(parsed.hour, parsed.minute), resolve((parsed.hour + 12) % 24, parsed.minute)]
      : [resolve(parsed.hour, parsed.minute)];
    // The yearless form only ever names a date within the weekly window; a
    // resolution further out means the date already passed and the walk landed
    // on NEXT year's occurrence — that's a misread, not an 11-month wait.
    const maxAhead = wallNow + 10 * 86_400_000;
    const future = candidates.filter(t => t != null && t > wallNow && t <= maxAhead);
    if (future.length === 0) return { at: wallNow + fallbackMs + marginMs, source: 'fallback' };
    return { at: Math.min(...future) + marginMs, source };
  }

  let at;
  if (parsed.ambiguous) {
    const t1 = nextOccurrence(parsed.hour, parsed.minute);
    const t2 = nextOccurrence((parsed.hour + 12) % 24, parsed.minute);
    at = Math.min(t1, t2);
  } else {
    at = nextOccurrence(parsed.hour, parsed.minute);
  }
  // Banner announced a clock time that (relative to wall clock) is already
  // past → the limit already reset; wake immediately rather than +24h.
  if (at <= wallNow) return { at: wallNow + marginMs, source };
  return { at: at + marginMs, source };
}

// Probe backoff: 15 → 30 → 60 min (capped). probeCount is 0-based number of
// completed probes so far. Hard ceiling is enforced by the caller against
// detectedAt + FALLBACK_RESET_MS.
export function nextProbeDelayMs(probeCount = 0, {
  intervalMs = 15 * 60_000,
  maxMs = 60 * 60_000,
} = {}) {
  const delay = intervalMs * (2 ** Math.max(0, probeCount));
  return Math.min(delay, maxMs);
}

export function sourceRank(source) {
  if (source === 'absolute') return 2;
  if (source === 'relative') return 1;
  return 0; // fallback / unknown
}
