// Semantic color tokens (matches assets/banner.svg).
// Discipline: amber = brand/selection/focus ONLY; state colors stay ANSI so
// warnings/errors read correctly on any terminal theme and in monochrome.
export const theme = {
  accent: '#f59e0b',   // amber — brand, active tab, focus
  accent2: '#fb7185',  // rose — z's, critical burn escalation
  ok: 'green',
  warn: 'yellow',
  crit: 'red',
  info: 'cyan',
  muted: 'gray',
  bright: 'white',
};

// Gauge color by usage threshold (accent-free: semantic only).
export function gaugeColor(pct) {
  if (!Number.isFinite(pct)) return theme.muted;
  if (pct >= 95) return theme.crit;
  if (pct >= 80) return theme.warn;
  return theme.ok;
}

// Status → { dot, color } — ● live/active, ◐ transitioning, ○ inert.
export function statusGlyph(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'stopped') return { dot: '●', color: theme.warn };
  if (s === 'resumed') return { dot: '●', color: theme.ok };
  if (s === 'resuming') return { dot: '◐', color: theme.info };
  if (s === 'failed') return { dot: '●', color: theme.crit };
  if (s === 'cancelled') return { dot: '○', color: theme.muted };
  return { dot: '·', color: theme.muted };
}
