import React from 'react';
import { Box, Text } from 'ink';
import { fmtCountdown, bar, countdownPct } from '../data.js';
import { theme, statusGlyph, gaugeColor } from '../theme.js';

const h = React.createElement;

export function StatusTab({ data, selected = 0 }) {
  if (!data) return h(Text, { color: theme.muted }, 'Loading…');
  const { sessions, paused, now } = data;
  const sorted = [...sessions].sort((a, b) => (a.resetAt || 0) - (b.resetAt || 0));

  return h(Box, { flexDirection: 'column' },
    h(Text, null,
      h(Text, { color: theme.bright }, `${sessions.length} tracked`),
      paused ? h(Text, { color: theme.warn }, ' · auto-resume PAUSED') : null,
    ),
    h(Text, null, ' '),
    sorted.length === 0
      ? h(Text, { color: theme.muted }, 'No tracked sessions — nothing is limit-stopped right now.')
      : sorted.map((s, i) => {
        const id = s.sessionId ? s.sessionId.slice(0, 8) : '(no id)';
        const sel = i === selected;
        const glyph = statusGlyph(s.status);
        const pct = countdownPct(s.resetAt, now);
        const cd = s.resetAt != null ? fmtCountdown(s.resetAt - now) : '?';
        return h(Box, { key: s.key || i, flexDirection: 'column', marginBottom: 1 },
          h(Text, null,
            h(Text, { color: theme.accent, bold: true }, sel ? '❯ ' : '  '),
            h(Text, { color: glyph.color }, `${glyph.dot} ${(s.status || '?').toUpperCase().padEnd(9)}`),
            h(Text, { color: theme.bright, bold: sel }, ` ${id}`),
            h(Text, { color: sel ? theme.bright : theme.muted },
              `  ${(s.agent || 'claude').padEnd(6)} ${(s.limitType || '?').padEnd(7)}`),
          ),
          s.cwd ? h(Text, { color: theme.muted }, `    ${s.cwd}`) : null,
          s.resetAt
            ? h(Text, null,
              h(Text, { color: theme.muted }, '    resets '),
              h(Text, { color: theme.bright }, cd),
              pct != null
                ? h(Text, { color: gaugeColor(pct) }, `  ${bar(pct, 14)}`)
                : null,
            )
            : null,
          h(Text, { color: theme.muted, dimColor: true },
            `    mux ${s.mux ?? '-'} · pane ${s.pane ?? '-'} · attempts ${s.attempts ?? 0}`
            + (s.lastError ? ` · err: ${String(s.lastError).slice(0, 40)}` : '')
            + (s.workspaceHold ? ' · held' : ''),
          ),
        );
      }),
  );
}
