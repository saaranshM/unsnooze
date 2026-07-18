import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logoContainsBrand } from '../src/dashboard/Logo.js';
import { shouldUseDashboard } from '../src/dashboard/run.js';
import {
  loadStatusSnapshot,
  loadLogsSnapshot,
  fmtCountdown,
  bar,
  countdownPct,
} from '../src/dashboard/data.js';

test('logo brand includes chevron and z frames', () => {
  const b = logoContainsBrand();
  assert.equal(b.hasZ, true);
  assert.equal(b.hasChevron, true);
  assert.ok(b.frames.length >= 4, 'animated: several z frames');
});

test('Logo renders a ">" chevron with rising z (ink renderToString)', async () => {
  const { renderToString } = await import('ink');
  const React = (await import('react')).default;
  const { Logo } = await import('../src/dashboard/Logo.js');
  const out = renderToString(React.createElement(Logo));
  // Two diagonal strokes meeting in a point — the ">" silhouette
  assert.match(out, /██▄/);
  assert.match(out, /▀██▄/);
  assert.match(out, /▄██▀/);
  assert.match(out, /██▀/);
  assert.match(out, /z/i);
  const compact = renderToString(React.createElement(Logo, { compact: true }));
  assert.match(compact, /❯/);
  assert.match(compact, /z z z/);
});

test('markPlainText: plain fallback logo has chevron + z', async () => {
  const { markPlainText } = await import('../src/dashboard/mark.js');
  const txt = markPlainText();
  assert.equal(txt.split('\n').length, 6);
  assert.match(txt, /█/);
  assert.match(txt, /z/i);
});

test('shouldUseDashboard: TTY yes, pipe/json/CI no', () => {
  assert.equal(shouldUseDashboard({ isTTY: true, env: {} }), true);
  assert.equal(shouldUseDashboard({ isTTY: false, env: {} }), false);
  assert.equal(shouldUseDashboard({ isTTY: true, json: true, env: {} }), false);
  assert.equal(shouldUseDashboard({ isTTY: true, env: { NO_COLOR: '1' } }), false);
  assert.equal(shouldUseDashboard({ isTTY: true, env: { CI: 'true' } }), false);
});

test('loadStatusSnapshot returns shape', () => {
  const s = loadStatusSnapshot();
  assert.ok(Array.isArray(s.sessions));
  assert.equal(typeof s.paused, 'boolean');
  assert.ok(Number.isFinite(s.now));
});

test('loadLogsSnapshot never throws', () => {
  const l = loadLogsSnapshot({ maxLines: 5 });
  assert.ok(Array.isArray(l.lines));
  assert.ok(l.path);
});

test('fmtCountdown / bar / countdownPct', () => {
  assert.equal(fmtCountdown(0), 'due now');
  assert.match(fmtCountdown(90_000), /m/);
  assert.equal(bar(50, 10).length, 10);
  assert.equal(countdownPct(Date.now() - 1000, Date.now()), 100);
});

test('FleetTab renders host states, sessions, and attach hints', async () => {
  const { renderToString } = await import('ink');
  const React = (await import('react')).default;
  const { FleetTab } = await import('../src/dashboard/tabs/FleetTab.js');
  const data = [
    { host: 'gpu', state: 'online', latencyMs: 200, at: Date.now(), dest: 'ubuntu@10.0.0.7',
      envelope: { sessions: [{ key: 'k1', agent: 'claude', status: 'stopped', resetAt: Date.now() + 3_600_000, mux: 'tmux', muxSession: 'unsnooze', cwd: '/w' }] } },
    { host: 'dead', state: 'unreachable', at: Date.now(), dest: 'dead', error: 'timeout' },
    { host: 'old', state: 'skew', at: Date.now(), dest: 'old' },
  ];
  const out = renderToString(React.createElement(FleetTab, { data, selected: 0 }));
  assert.match(out, /gpu/);
  assert.match(out, /online/);
  assert.match(out, /STOPPED|stopped/);
  assert.match(out, /ssh -t ubuntu@10\.0\.0\.7/);
  assert.match(out, /unreachable/);
  assert.match(out, /skew/);
});

test('FleetTab renders needs-auth as a distinct glyph (◐, warn) from unreachable (○, crit)', async () => {
  const { renderToString } = await import('ink');
  const React = (await import('react')).default;
  const { FleetTab } = await import('../src/dashboard/tabs/FleetTab.js');
  const data = [
    { host: 'lap', state: 'needs-auth', at: Date.now(), dest: 'me@lap', error: 'no resolvable credential' },
    { host: 'dead', state: 'unreachable', at: Date.now(), dest: 'dead', error: 'timeout' },
  ];
  const out = renderToString(React.createElement(FleetTab, { data, selected: 0 }));
  assert.match(out, /needs-auth/);
  assert.match(out, /◐/);
  assert.match(out, /○/);
});

test('flattenFleetStopped carries the full host descriptor (entry) alongside dest, so R/C actions can use password auth', async () => {
  const { flattenFleetStopped } = await import('../src/dashboard/data.js');
  const entry = { dest: 'me@gpu', auth: 'password', source: 'command', cmd: 'op read x' };
  const data = [
    { host: 'gpu', state: 'online', dest: entry.dest, entry,
      envelope: { sessions: [{ key: 'k1', status: 'stopped' }] } },
  ];
  const rows = flattenFleetStopped(data);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].entry, entry);
  assert.equal(rows[0].dest, 'me@gpu');
});

test('FleetTab shows a per-host auth badge (key vs pw:<source>)', async () => {
  const { renderToString } = await import('ink');
  const React = (await import('react')).default;
  const { FleetTab } = await import('../src/dashboard/tabs/FleetTab.js');
  const data = [
    { host: 'vpc', state: 'online', dest: 'ubuntu@vpc', entry: { dest: 'ubuntu@vpc', auth: 'key' }, envelope: { sessions: [] } },
    { host: 'gpu', state: 'online', dest: 'me@gpu', entry: { dest: 'me@gpu', auth: 'password', source: 'command', cmd: 'op read x' }, envelope: { sessions: [] } },
    { host: 'lap', state: 'needs-auth', dest: 'me@lap', entry: { dest: 'me@lap', auth: 'password', source: 'prompt' }, error: 'no resolvable credential' },
  ];
  const out = renderToString(React.createElement(FleetTab, { data, selected: 0 }));
  assert.match(out, /\bkey\b/);          // key host badge
  assert.match(out, /pw:command/);        // password/command host
  assert.match(out, /pw:prompt/);         // password/prompt host (needs-auth) still shows its auth
  // A host with no descriptor (e.g. legacy/absent) renders no badge and doesn't crash
  const bare = renderToString(React.createElement(FleetTab, {
    data: [{ host: 'x', state: 'online', dest: 'x', envelope: { sessions: [] } }], selected: 0,
  }));
  assert.match(bare, /x/);
});
