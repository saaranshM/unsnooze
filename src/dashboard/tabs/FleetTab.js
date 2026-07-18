import React from 'react';
import { Box, Text } from 'ink';
import { fmtCountdown, flattenFleetStopped } from '../data.js';
import { theme } from '../theme.js';
import { Clickable } from '../mouse.js';
import { attachHintRemote } from '../../fleet.js';

const h = React.createElement;

// Host-header glyph/label/color for each fetchFleet() state.
function hostHeader(r, now) {
  if (r.state === 'online') {
    const lat = r.latencyMs != null ? ` (${r.latencyMs}ms)` : '';
    return { glyph: '●', color: theme.ok, label: `online${lat}` };
  }
  if (r.state === 'stale') {
    const age = Number.isFinite(r.cachedAt) ? ` (${fmtCountdown(now - r.cachedAt)} old)` : '';
    return { glyph: '◌', color: theme.muted, label: `stale${age}` };
  }
  if (r.state === 'skew') {
    return { glyph: '△', color: theme.warn, label: 'version skew — update remote' };
  }
  if (r.state === 'needs-auth') {
    return { glyph: '◐', color: theme.warn, label: `needs-auth${r.error ? ` (${r.error})` : ''}` };
  }
  if (r.state === 'unreachable') {
    return { glyph: '○', color: theme.crit, label: `unreachable${r.error ? ` (${r.error})` : ''}` };
  }
  return { glyph: '○', color: theme.crit, label: `error${r.error ? ` (${r.error})` : ''}` };
}

export function FleetTab({ data, selected = 0, onSelect } = {}) {
  if (!data) return h(Text, { color: theme.muted }, 'Loading…');
  if (data.length === 0) {
    return h(Box, { flexDirection: 'column' },
      h(Text, { color: theme.muted }, 'No hosts registered.'),
      h(Text, null, ' '),
      h(Text, { color: theme.info }, '  unsnooze hosts add <name> [ssh-destination]'),
    );
  }

  const now = Date.now();
  // Shared with App.js's R/C keybinding math so the rendered order and the
  // "selected row" the keys act on can never drift apart.
  const indexOf = new Map(flattenFleetStopped(data).map((f, i) => [f.session, i]));

  return h(Box, { flexDirection: 'column' },
    h(Text, { color: theme.muted }, `${data.length} host(s)`),
    h(Text, null, ' '),
    ...data.map((r) => {
      const head = hostHeader(r, now);
      const sessions = (r.envelope?.sessions ?? []).filter(s => s.status === 'stopped');
      return h(Box, { key: r.host, flexDirection: 'column', marginBottom: 1 },
        h(Text, null,
          h(Text, { color: head.color }, `${head.glyph} `),
          h(Text, { color: theme.bright, bold: true }, r.host),
          h(Text, { color: head.color }, ` ${head.label}`),
        ),
        sessions.length === 0
          ? h(Text, { color: theme.muted, dimColor: true }, '    (no stopped sessions)')
          : sessions.map((s) => {
            const i = indexOf.get(s);
            const sel = i === selected;
            const id = s.sessionId ? s.sessionId.slice(0, 8) : (s.key ? s.key.slice(0, 8) : '(no id)');
            const cd = Number.isFinite(s.resetAt) ? fmtCountdown(s.resetAt - now) : '?';
            const hint = s.muxSession ? attachHintRemote(r.dest || r.host, s.mux || 'tmux', s.muxSession) : null;
            return h(Clickable, { key: s.key || i, onClick: () => onSelect?.(i), flexDirection: 'column' },
              h(Text, null,
                h(Text, { color: theme.accent, bold: true }, sel ? '❯ ' : '  '),
                h(Text, { color: theme.warn }, `● STOPPED `),
                h(Text, { color: theme.bright, bold: sel }, ` ${id}`),
                h(Text, { color: sel ? theme.bright : theme.muted }, `  ${(s.agent || 'claude').padEnd(6)}`),
                h(Text, { color: theme.muted }, `  resets ${cd}`),
              ),
              hint ? h(Text, { color: theme.info }, `      attach: ${hint}`) : null,
            );
          }),
      );
    }),
  );
}
