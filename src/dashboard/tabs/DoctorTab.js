import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

const h = React.createElement;

export function DoctorTab({ data }) {
  if (!data) return h(Text, { color: theme.muted }, 'Running checks…');
  const legacy = data.findings.filter(f => f.kind === 'legacy');
  const health = data.findings.filter(f => f.kind === 'health');
  const info = data.findings.filter(f => f.kind === 'info');

  if (data.healthy) {
    return h(Box, { flexDirection: 'column' },
      h(Text, { color: theme.ok }, '✓ install is healthy'),
      ...info.map((f, i) => h(Text, { key: i, color: theme.muted }, `· ${f.title}`)),
    );
  }

  return h(Box, { flexDirection: 'column' },
    legacy.length ? h(Text, { color: theme.warn, bold: true }, 'legacy csg leftovers') : null,
    ...legacy.map((f, i) => h(Box, { key: 'l' + i, flexDirection: 'column' },
      h(Text, { color: theme.crit }, `✗ ${f.title}`),
      f.detail ? h(Text, { color: theme.muted }, `  ${String(f.detail).split('\n')[0]}`) : null,
    )),
    health.length ? h(Text, { color: theme.warn, bold: true }, 'install health') : null,
    ...health.map((f, i) => h(Box, { key: 'h' + i, flexDirection: 'column' },
      h(Text, { color: theme.crit }, `✗ ${f.title}`),
      f.detail ? h(Text, { color: theme.muted }, `  ${String(f.detail).split('\n')[0]}`) : null,
    )),
    ...info.map((f, i) => h(Text, { key: 'i' + i, color: theme.muted }, `· ${f.title}`)),
    h(Text, null, ' '),
    h(Text, { color: theme.muted }, 'Run `unsnooze doctor --fix` outside the dashboard to apply fixes.'),
  );
}
