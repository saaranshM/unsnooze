// Parse reset banner text (Claude Code or Codex CLI) into an absolute
// epoch-ms reset time. DST-safe: resolves "resets 3pm (UTC)" via iterative
// correction in the stated timezone rather than naive offset math.

// Optional weekday between "resets" and the time covers weekly banners
// ("resets Tuesday 9am (UTC)").
const RESET_TIME_REGEX = /resets?\s+(?:at\s+)?(?:on\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;
const RELATIVE_TIME_REGEX = /(?:try again|wait|resets?\s+in)[:\s]\s*(?:for\s+)?(?:in\s+)?(\d+)\s*(hours?|minutes?|mins?|h|m)\b/i;
// "resets Tuesday 3pm" / "resets on Mon" — weekly limits carry a day name.
const DAY_REGEX = /resets?\s+(?:on\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*/i;
const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// Codex CLI forms ("try again at …", local time):
//   same day:  "or try again at 3:51 PM."
//   cross-day: "or try again at Feb 23rd, 2026 9:01 PM."
//   older:     "Try again in 4 days 20 hours 9 minutes."
const TRY_AT_TIME_REGEX = /try again at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
const TRY_AT_DATE_REGEX = /try again at\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)/i;
const MULTI_RELATIVE_REGEX = /try again in\s+(?:(\d+)\s*days?\s*)?(?:(\d+)\s*hours?\s*)?(?:(\d+)\s*min(?:ute)?s?)?/i;
const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function to24h(hour, ampm) {
  let h = hour;
  if (ampm === 'pm' && h !== 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return h;
}

export function parseResetTime(text) {
  if (!text) return null;

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
    return {
      hour: to24h(parseInt(tryAtMatch[1], 10), tryAtMatch[3].toLowerCase()),
      minute: tryAtMatch[2] ? parseInt(tryAtMatch[2], 10) : 0,
      timezone: null, ambiguous: false, day: null,
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
    return {
      hour, minute, timezone, ambiguous,
      day: dayMatch ? DAY_INDEX[dayMatch[1].toLowerCase()] : null,
    };
  }

  const relMatch = text.match(RELATIVE_TIME_REGEX);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const isMinutes = unit.startsWith('m');
    return { relative: true, waitMs: amount * (isMinutes ? 60_000 : 3_600_000) };
  }

  // Multi-unit relative ("in 4 days 20 hours 9 minutes") — checked after the
  // single-unit form, which already covers "in 2 hours" / "in 5 minutes".
  const multiMatch = text.match(MULTI_RELATIVE_REGEX);
  if (multiMatch && (multiMatch[1] || multiMatch[2] || multiMatch[3])) {
    const days = parseInt(multiMatch[1] || '0', 10);
    const hours = parseInt(multiMatch[2] || '0', 10);
    const minutes = parseInt(multiMatch[3] || '0', 10);
    return { relative: true, waitMs: ((days * 24 + hours) * 60 + minutes) * 60_000 };
  }

  // Day-only weekly banner ("resets Tuesday") with no time — midnight-ish target,
  // resolved by resetAtMs via hour 0.
  if (dayMatch) {
    return { hour: 0, minute: 0, timezone: null, ambiguous: false, day: DAY_INDEX[dayMatch[1].toLowerCase()] };
  }

  return null;
}

// Convert parsed reset info into an absolute epoch ms (includes margin).
// Unparseable input falls back to now + fallbackMs.
export function resetAtMs(parsed, { marginMs = 60_000, fallbackMs = 5 * 3_600_000, now = new Date() } = {}) {
  const source = !parsed ? 'fallback' : parsed.relative ? 'relative' : 'absolute';
  if (!parsed) return { at: now.getTime() + fallbackMs + marginMs, source };
  if (parsed.relative) return { at: now.getTime() + parsed.waitMs + marginMs, source };
  // Pre-resolved epoch (full-date banner, local time). A stale past date means
  // we misread the banner — fall back rather than firing immediately.
  if (parsed.absolute) {
    if (parsed.atMs <= now.getTime()) return { at: now.getTime() + fallbackMs + marginMs, source: 'fallback' };
    return { at: parsed.atMs + marginMs, source };
  }

  let tz;
  try {
    tz = parsed.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return { at: now.getTime() + fallbackMs + marginMs, source: 'fallback' };
  }

  // DST-safe: build today's date in the target tz, then iteratively correct the
  // UTC guess until it formats as the desired local h:m. Correction normalized
  // to [-720, +720] minutes to take the minimum-magnitude step (avoids the
  // off-by-a-day bug in high-offset timezones).
  function targetTimestamp(h, m) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour12: false,
    }).formatToParts(now);
    const y = parseInt(parts.find(p => p.type === 'year').value);
    const mo = parseInt(parts.find(p => p.type === 'month').value);
    const d = parseInt(parts.find(p => p.type === 'day').value);

    const targetStr = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    let candidate = new Date(targetStr + 'Z').getTime();
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

  function nextOccurrence(h, m) {
    let t = targetTimestamp(h, m);
    if (t <= now.getTime()) t += 86_400_000;
    if (parsed.day != null) {
      // Roll forward to the named weekday (in the target tz).
      for (let i = 0; i < 7; i++) {
        const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' })
          .format(new Date(t)).toLowerCase().slice(0, 3);
        if (DAY_INDEX[wd] === parsed.day) break;
        t += 86_400_000;
      }
    }
    return t;
  }

  let at;
  if (parsed.ambiguous) {
    const t1 = nextOccurrence(parsed.hour, parsed.minute);
    const t2 = nextOccurrence((parsed.hour + 12) % 24, parsed.minute);
    at = Math.min(t1, t2);
  } else {
    at = nextOccurrence(parsed.hour, parsed.minute);
  }
  return { at: at + marginMs, source };
}
