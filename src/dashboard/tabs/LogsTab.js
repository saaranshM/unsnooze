import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

const h = React.createElement;

export function LogsTab({ data, maxRows = 20 }) {
  if (!data) return h(Text, { color: theme.muted }, 'Loading logs…');
  if (data.missing) return h(Text, { color: theme.muted }, `No log file yet (${data.path})`);
  // Alt-screen has no scrollback — show the freshest tail that fits.
  const visible = data.lines.slice(-Math.max(1, maxRows - 2));
  return h(Box, { flexDirection: 'column' },
    h(Text, { color: theme.muted, dimColor: true }, data.path),
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
