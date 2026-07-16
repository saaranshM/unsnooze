import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

const h = React.createElement;

export function SessionsTab({ data, selected = 0 }) {
  if (!data) return h(Text, { color: theme.muted }, 'Loading…');
  if (data.length === 0) return h(Text, { color: theme.muted }, 'No unsnooze-owned mux sessions.');

  return h(Box, { flexDirection: 'column' },
    h(Text, { color: theme.muted }, `${data.length} mux session(s)`),
    h(Text, null, ' '),
    ...data.map((s, i) => {
      const sel = i === selected;
      return h(Box, { key: s.name + s.mux, flexDirection: 'column', marginBottom: 1 },
        h(Text, null,
          h(Text, { color: theme.accent, bold: true }, sel ? '❯ ' : '  '),
          h(Text, { color: s.exited ? theme.muted : theme.ok }, s.exited ? '○ exited' : '● live  '),
          h(Text, { color: theme.bright, bold: sel }, ` ${s.name}`),
          h(Text, { color: theme.muted }, `  (${s.mux})`),
        ),
        h(Text, { color: theme.muted }, `    panes: ${s.panes?.length ? s.panes.join(', ') : '(none)'}`),
        s.attach ? h(Text, { color: theme.info }, `    attach: ${s.attach}`) : null,
        ...(s.records || []).map((r, j) =>
          h(Text, { key: j, color: theme.muted, dimColor: true },
            `    · ${r.status} ${(r.agent || '?').padEnd(6)} ${(r.cwd || '?').slice(0, 48)} pane ${r.pane ?? '-'}`),
        ),
      );
    }),
  );
}
