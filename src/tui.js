// Branded terminal chrome for data-rich user-facing commands.
// Logo: ❯ (angled prompt) + z z z — matches assets/banner.svg.
// Plain / pipe formatters (picocolors). Live UI is src/dashboard/ (Ink).

import pc from 'picocolors';
import { markRows } from './dashboard/mark.js';

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

export function shouldUseTui({
  force = null,
  json = false,
  isTTY = process.stdout?.isTTY,
  env = process.env,
} = {}) {
  if (force === true) return true;
  if (force === false) return false;
  if (json) return false;
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return false;
  if (env.CI === 'true' || env.CI === '1') return false;
  if (env.TERM === 'dumb') return false;
  return !!isTTY;
}

// ---------------------------------------------------------------------------
// Color helpers (no-op styles when color off)
// ---------------------------------------------------------------------------

function makeColors(enabled) {
  if (!enabled) {
    const id = s => String(s ?? '');
    return {
      enabled: false,
      amber: id, muted: id, bright: id, green: id, red: id, cyan: id,
      yellow: id, bold: id, dim: id, strike: id,
    };
  }
  return {
    enabled: true,
    amber: s => pc.yellow(pc.bold(String(s ?? ''))),
    muted: s => pc.dim(pc.gray(String(s ?? ''))),
    bright: s => pc.white(String(s ?? '')),
    green: s => pc.green(String(s ?? '')),
    red: s => pc.red(String(s ?? '')),
    cyan: s => pc.cyan(String(s ?? '')),
    yellow: s => pc.yellow(String(s ?? '')),
    bold: s => pc.bold(String(s ?? '')),
    dim: s => pc.dim(String(s ?? '')),
    strike: s => pc.strikethrough(String(s ?? '')),
  };
}

export function colors(enabled = true) {
  return makeColors(enabled);
}

// ---------------------------------------------------------------------------
// Brand logo — compact ASCII angled bracket + zzz (no wordmark)
// ---------------------------------------------------------------------------

export function logoBlock(title, {
  color = true,
  subtitle = null,
} = {}) {
  const c = makeColors(color);
  const nl = String.fromCharCode(10);
  const lines = markRows().map(r =>
    c.amber(r.chevron) + ' ' + c.yellow(r.zs.trimEnd()));
  if (title || subtitle) lines.push(c.dim('  ' + (subtitle || title)));
  return lines.join(nl);
}

// Layout primitives
// ---------------------------------------------------------------------------

export function bar(pct, width = 20, { color = true } = {}) {
  const p = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;
  const filled = Math.round((p / 100) * width);
  const body = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
  if (!color) return body;
  if (p >= 95) return pc.red(body);
  if (p >= 80) return pc.yellow(body);
  return pc.green(body);
}

export function badge(status, { color = true } = {}) {
  const c = makeColors(color);
  const s = String(status || '?').toUpperCase();
  const label = s.padEnd(9);
  if (s === 'STOPPED') return c.yellow(`● ${label}`);
  if (s === 'RESUMED') return c.green(`● ${label}`);
  if (s === 'FAILED') return c.red(`● ${label}`);
  if (s === 'RESUMING') return c.cyan(`● ${label}`);
  if (s === 'CANCELLED') return c.muted(`○ ${label}`);
  return c.dim(`· ${label}`);
}

export function section(title, { color = true } = {}) {
  const c = makeColors(color);
  return c.dim(`── ${title} ${'─'.repeat(Math.max(4, 24 - String(title).length))}`);
}

export function dim(text, { color = true } = {}) {
  return makeColors(color).dim(text);
}

export function truncate(str, max = 56) {
  const s = String(str ?? '');
  if (s.length <= max) return s;
  if (max < 8) return s.slice(0, max);
  const keep = max - 1;
  const head = Math.ceil(keep * 0.55);
  const tail = keep - head;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function makeTable(headers, rows, { color = true } = {}) {
  const c = makeColors(color);
  const cols = headers.map((h, i) => {
    const cells = [String(h), ...rows.map(r => String(r[i] ?? ''))];
    const w = Math.min(40, Math.max(...cells.map(s => s.length), 4));
    return w;
  });
  const fmt = (cells) => cells.map((cell, i) => String(cell).padEnd(cols[i]).slice(0, cols[i])).join('  ');
  const lines = [c.dim(fmt(headers)), c.dim(cols.map(w => '─'.repeat(w)).join('  '))];
  for (const row of rows) lines.push(fmt(row));
  return lines.join(String.fromCharCode(10));
}

export function joinBlocks(...blocks) {
  return blocks.filter(Boolean).join('\n');
}

// Countdown fraction for progress bar: higher = closer to reset / due.
export function countdownPct(resetAt, now = Date.now(), windowMs = 5 * 3_600_000) {
  if (!Number.isFinite(resetAt)) return null;
  const remain = resetAt - now;
  if (remain <= 0) return 100;
  return Math.min(100, Math.max(0, 100 - (remain / windowMs) * 100));
}

// ---------------------------------------------------------------------------
// Command formatters (consume pre-built data; no I/O)
// ---------------------------------------------------------------------------

export function formatStatusTui({
  sessions = [],
  resumerPid = null,
  paused = false,
  now = Date.now(),
  fmtCountdown,
  fmtResetProvenance,
  approxTokens,
  contextTokensFor,
  attachHintFor,
  color = true,
} = {}) {
  const c = makeColors(color);
  const lines = [
    logoBlock('status', { color }),
    `  ${c.dim(`${sessions.length} tracked`)} · ${c.dim(`daemon ${resumerPid ?? 'not running'}`)}${paused ? c.yellow(' · PAUSED') : ''}`,
    '',
  ];
  if (sessions.length === 0) {
    lines.push(c.dim('  no tracked sessions.'));
    if (paused) lines.push(c.dim('  (auto-resume off — `unsnooze config set autoResume on`)'));
    return lines.join(String.fromCharCode(10));
  }
  const sorted = [...sessions].sort((a, b) => (a.resetAt || 0) - (b.resetAt || 0));
  for (const s of sorted) {
    const id = s.sessionId ? s.sessionId.slice(0, 8) : '(no id)';
    const agent = (s.agent || 'claude').padEnd(6);
    const lim = (s.limitType || 'unknown').padEnd(7);
    lines.push(`  ${badge(s.status, { color })} ${c.bright(id)}  ${agent} ${lim}`);
    if (s.cwd) lines.push(`    ${c.dim(truncate(s.cwd, 64))}`);
    if (s.resetAt) {
      const when = `${new Date(s.resetAt).toLocaleString()} (${fmtCountdown(s.resetAt - now)})`;
      const pct = countdownPct(s.resetAt, now);
      const b = pct != null ? `  ${bar(pct, 12, { color })}` : '';
      lines.push(`    resets  ${when}${b}`);
      lines.push(`            ${c.dim(fmtResetProvenance(s))}`);
    }
    const bits = [];
    if (s.status === 'stopped' && typeof contextTokensFor === 'function') {
      try {
        const t = contextTokensFor(s);
        if (t != null) bits.push(`ctx ${approxTokens(t)} tok`);
      } catch { /* omit */ }
    }
    const pane = s.paneOwner ? `${s.paneOwner}:${s.pane ?? '-'}` : (s.pane ?? '-');
    bits.push(`mux ${s.mux ?? '-'}`);
    bits.push(`pane ${pane}`);
    if (s.attempts != null) bits.push(`attempts ${s.attempts}`);
    if (s.workspaceHold) bits.push(`held: ${s.holdReason ?? '?'}`);
    if (s.lastError) bits.push(`err: ${truncate(s.lastError, 40)}`);
    if (typeof attachHintFor === 'function') {
      try {
        const a = attachHintFor(s);
        if (a) bits.push(`attach: ${a}`);
      } catch { /* omit */ }
    }
    if (bits.length) lines.push(`    ${c.dim(bits.join(' · '))}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function formatUsageTui(report, {
  color = true,
  asciiBar: barFn = bar,
  fmtDuration: durFn = null,
  fmtUsageProvenance: provFn = null,
} = {}) {
  const c = makeColors(color);
  const warn = (report.warnAt || [80, 95]).join(',');
  const daemon = report.daemonRunning ? 'running' : 'not running';
  const lines = [
    logoBlock('usage', {
      color,
      subtitle: `account burn & time-to-limit · daemon ${daemon} · warnings ${warn}%`,
    }),
    '',
  ];

  const fmtTok = (n) => {
    if (!Number.isFinite(n)) return '?';
    if (n >= 1000) return `~${Math.round(n / 1000)}k`;
    return `~${Math.round(n)}`;
  };
  const fmtReset = (ms) => {
    if (!Number.isFinite(ms)) return null;
    try {
      return new Date(ms).toLocaleString(undefined, {
        weekday: ms - Date.now() > 86_400_000 ? 'short' : undefined,
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return new Date(ms).toISOString();
    }
  };
  const fmtDur = durFn || ((ms) => {
    if (!Number.isFinite(ms) || ms < 0) return null;
    const m = Math.round(ms / 60_000);
    if (m < 60) return `${Math.max(1, m)}m`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
  });
  const prov = provFn || ((ladder) => {
    if (!ladder) return '(estimated)';
    if (ladder.tier === 'exact') return '(exact)';
    if (ladder.tier === 'calibrated') {
      const n = ladder.stopCount || 0;
      return `(calibrated from ${n} stop${n === 1 ? '' : 's'})`;
    }
    return '(estimated — calibrating, needs one observed limit stop)';
  });

  for (const a of report.agents || []) {
    if (!a.windows || a.windows.length === 0) {
      lines.push(`  ${c.bright(a.agent.padEnd(7))} ${c.dim('(no recent usage data)')}`);
      lines.push('');
      continue;
    }
    let first = true;
    for (const w of a.windows) {
      const pctStr = w.ladder?.pct != null
        ? `${w.ladder.tier === 'exact' ? '' : '~'}${Math.round(w.ladder.pct)}%${w.ladder.tier === 'exact' ? ' used' : ''}`
        : (w.ladder?.used != null ? `${fmtTok(w.ladder.used)} weighted tok` : '—');
      const b = barFn(w.ladder?.pct ?? 0, 20, { color });
      const head = first ? c.bright(a.agent.padEnd(7)) : ' '.repeat(7);
      lines.push(`  ${head} ${String(w.label).padEnd(7)} [${b}]  ${pctStr}  ${c.dim(prov(w.ladder))}`);
      first = false;
      if (w.burn && !w.infoOnly) {
        if (w.burn.idle) lines.push(`          burn    ${c.dim('idle — no active burn')}`);
        else if (w.burn.warmingUp) lines.push(`          burn    ${c.dim('warming up (<10 active min)')}`);
        else if (w.burn.unit === 'pct') {
          lines.push(`          burn    ~${w.burn.burnPerMin.toFixed(2)} %/min over last ${Math.round(w.burn.activeMin)} active min`);
        } else {
          lines.push(`          burn    ${fmtTok(w.burn.burnPerMin)} weighted tok/min over last ${Math.round(w.burn.activeMin)} active min`);
        }
      }
      if (w.eta && !w.infoOnly) {
        const lo = fmtDur(w.eta.loMs);
        const hi = fmtDur(w.eta.hiMs);
        const wall = lo && hi && lo !== hi ? `~${lo}–${hi}` : `~${lo || hi}`;
        const reset = w.resetsAtMs
          ? ` · window resets ${fmtReset(w.resetsAtMs)}${w.resetSource ? ` (${w.resetSource})` : ''}`
          : '';
        lines.push(`          wall    ${wall} at this pace${reset}`);
      } else if (w.resetsAtMs) {
        const src = w.resetSource ? ` (${w.resetSource})` : '';
        lines.push(`                  resets ${fmtReset(w.resetsAtMs)}${src}`);
      }
    }
    lines.push('');
  }
  lines.push(c.dim('  Estimates are a lower bound: Claude quotas are account-pooled with claude.ai/Desktop.'));
  lines.push(c.dim('  Exact Claude percentages available via: unsnooze usage --install-statusline'));
  return lines.join(String.fromCharCode(10));
}

export function formatSessionsTui(owned, { color = true } = {}) {
  const c = makeColors(color);
  const lines = [logoBlock('sessions', { color, subtitle: `${owned.length} mux session(s)` }), ''];
  if (owned.length === 0) {
    lines.push(c.dim('  no unsnooze-owned mux sessions found.'));
    return lines.join(String.fromCharCode(10));
  }
  const rows = owned.map(s => {
    const flag = s.exited ? c.muted('EXITED') : c.green('live');
    const panes = s.panes.length ? s.panes.join(', ') : '(none)';
    return [flag, s.mux, s.name, panes, s.attach || '—'];
  });
  lines.push(makeTable(['state', 'mux', 'name', 'panes', 'attach'], rows, { color }));
  for (const s of owned) {
    if (!s.records?.length) continue;
    lines.push('');
    lines.push(c.dim(`  records in ${s.name}:`));
    for (const r of s.records) {
      lines.push(`    ${badge(r.status, { color })} ${(r.agent || '?').padEnd(6)} ${c.dim(truncate(r.cwd || '?', 48))} pane ${r.pane ?? '-'}`);
    }
  }
  return lines.join(String.fromCharCode(10));
}

export function formatDoctorTui(report, { color = true } = {}) {
  const c = makeColors(color);
  const legacy = report.findings.filter(f => f.kind === 'legacy');
  const health = report.findings.filter(f => f.kind === 'health');
  const info = report.findings.filter(f => f.kind === 'info');
  const lines = [
    logoBlock('doctor', {
      color,
      subtitle: report.healthy ? 'all clear' : 'issues found',
    }),
    '',
  ];
  if (report.healthy) {
    lines.push(c.green('  ✓ install is healthy.'));
    for (const f of info) lines.push(c.dim(`  · ${f.title}`));
    return lines.join(String.fromCharCode(10));
  }
  if (legacy.length) {
    lines.push(section('legacy csg leftovers', { color }));
    for (const f of legacy) {
      lines.push(c.red(`  ✗ ${f.title}`));
      if (f.detail) lines.push(c.dim(`    ${f.detail.split('\n').join('\n    ')}`));
    }
    lines.push('');
  }
  if (health.length) {
    lines.push(section('install health', { color }));
    for (const f of health) {
      lines.push(c.red(`  ✗ ${f.title}`));
      if (f.detail) lines.push(c.dim(`    ${f.detail.split('\n').join('\n    ')}`));
    }
    lines.push('');
  }
  for (const f of info) lines.push(c.dim(`  · ${f.title}`));
  return lines.join('\n').trimEnd();
}

export function formatPreviewTui(entries, { color = true } = {}) {
  const c = makeColors(color);
  const lines = [
    logoBlock('preview', {
      color,
      subtitle: 'what WOULD happen right now (nothing is sent)',
    }),
    '',
  ];
  if (entries.length === 0) {
    lines.push(c.dim('  no matching sessions.'));
    return lines.join(String.fromCharCode(10));
  }
  for (const e of entries) {
    lines.push(`  ${badge(e.status, { color })} ${c.bright(e.id)}  ${(e.agent || 'claude').padEnd(6)}`);
    if (e.cwd) lines.push(`    ${c.dim(truncate(e.cwd, 64))}`);
    lines.push(`    ${c.bold(e.verb)}`);
    for (const g of e.gates || []) lines.push(`    ${c.dim('· ' + g)}`);
    if (e.message) lines.push(`    ${c.dim('message: "' + truncate(e.message, 100) + '"')}`);
    lines.push('');
  }
  lines.push(c.dim('  Nothing was typed, opened, or modified.'));
  lines.push(c.dim('  `unsnooze resume-now <id>` wakes a session immediately.'));
  return lines.join(String.fromCharCode(10));
}

export function logoLine(title = '') {
  return `❯ zzz  unsnooze${title ? ` · ${title}` : ''}`;
}
