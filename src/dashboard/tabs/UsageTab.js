import React from 'react';
import { Box, Text } from 'ink';
import { bar } from '../data.js';
import { theme, gaugeColor } from '../theme.js';
import { fmtUsageProvenance, fmtDuration } from '../../usage.js';

const h = React.createElement;

function fmtTok(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1000) return `~${Math.round(n / 1000)}k`;
  return `~${Math.round(n)}`;
}

export function UsageTab({ data }) {
  if (!data) return h(Text, { color: theme.muted }, 'Loading usage… (cold scan)');
  const warn = (data.warnAt || [80, 95]).join(',');
  const daemon = data.daemonRunning ? 'running' : 'not running';

  return h(Box, { flexDirection: 'column' },
    h(Text, { color: theme.muted }, `daemon ${daemon} · warnings at ${warn}%`),
    h(Text, null, ' '),
    ...(data.agents || []).flatMap(a => {
      if (!a.windows?.length) {
        return [h(Text, { key: a.agent },
          h(Text, { color: theme.bright, bold: true }, a.agent.padEnd(7)),
          h(Text, { color: theme.muted }, ' (no recent usage data)'),
        ), h(Text, { key: a.agent + '-sp' }, ' ')];
      }
      const rows = a.windows.map((w, i) => {
        const pct = w.ladder?.pct;
        const pctStr = pct != null
          ? `${w.ladder.tier === 'exact' ? '' : '~'}${Math.round(pct)}%${w.ladder.tier === 'exact' ? ' used' : ''}`
          : (w.ladder?.used != null ? `${fmtTok(w.ladder.used)} tok` : '—');
        const lines = [
          h(Text, { key: `${a.agent}-${w.label}-h` },
            h(Text, { color: theme.bright, bold: i === 0 }, (i === 0 ? a.agent : '').padEnd(7)),
            h(Text, { color: theme.muted }, ` ${String(w.label).padEnd(7)} `),
            h(Text, { color: Number.isFinite(pct) ? gaugeColor(pct) : theme.muted }, bar(pct ?? 0, 20)),
            h(Text, { color: theme.bright }, ` ${pctStr} `),
            h(Text, { color: theme.muted, dimColor: true }, fmtUsageProvenance(w.ladder)),
          ),
        ];
        if (w.burn && !w.infoOnly) {
          let burnLine = 'idle — no active burn';
          if (w.burn.warmingUp) burnLine = 'warming up (<10 active min)';
          else if (!w.burn.idle && w.burn.unit === 'pct') {
            burnLine = `~${w.burn.burnPerMin.toFixed(2)} %/min · ${Math.round(w.burn.activeMin)} active min`;
          } else if (!w.burn.idle) {
            burnLine = `${fmtTok(w.burn.burnPerMin)} tok/min · ${Math.round(w.burn.activeMin)} active min`;
          }
          lines.push(h(Text, { key: `${a.agent}-${w.label}-b`, color: theme.muted },
            `          burn  ${burnLine}`));
        }
        if (w.eta && !w.infoOnly) {
          const lo = fmtDuration(w.eta.loMs);
          const hi = fmtDuration(w.eta.hiMs);
          const wall = lo && hi && lo !== hi ? `~${lo}–${hi}` : `~${lo || hi}`;
          lines.push(h(Text, { key: `${a.agent}-${w.label}-e`, color: theme.warn },
            `          wall  ${wall} at this pace`));
        }
        return lines;
      });
      return [...rows.flat(), h(Text, { key: a.agent + '-gap' }, ' ')];
    }),
    h(Text, { color: theme.muted, dimColor: true }, 'Claude sums are a lower bound (account-pooled with claude.ai).'),
  );
}
