import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

const h = React.createElement;

export function LogsTab({ data, maxRows = 20, scroll = 0 }) {
  if (!data) return h(Text, { color: theme.muted }, 'Loading logs…');
  if (data.missing) return h(Text, { color: theme.muted }, `No log file yet (${data.path})`);
  const fit = Math.max(1, maxRows - 2);
  // Alt-screen has no scrollback — the wheel scrolls this window instead.
  const maxScroll = Math.max(0, data.lines.length - fit);
  const back = Math.min(scroll, maxScroll);
  const end = data.lines.length - back;
  const visible = data.lines.slice(Math.max(0, end - fit), end);
  return h(Box, { flexDirection: 'column' },
    h(Text, { color: theme.muted, dimColor: true },
      data.path + (back > 0 ? `  · scrolled ↑${back} (wheel down for live tail)` : '')),
    h(Text, null, ' '),
    ...visible.map((line, i) =>
      h(Text, {
        key: i,
        color: /\[hook\]|\[watcher\]/.test(line) ? theme.bright : theme.muted,
        wrap: 'truncate-end',
      }, line),
    ),
  );
}
