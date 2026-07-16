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
