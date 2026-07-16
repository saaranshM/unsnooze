import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldUseTui,
  logoBlock,
  logoLine,
  bar,
  badge,
  formatStatusTui,
  formatUsageTui,
  formatSessionsTui,
  formatDoctorTui,
  formatPreviewTui,
  countdownPct,
} from '../src/tui.js';

test('shouldUseTui: off for non-TTY, NO_COLOR, CI, json', () => {
  assert.equal(shouldUseTui({ isTTY: false }), false);
  assert.equal(shouldUseTui({ isTTY: true, json: true }), false);
  assert.equal(shouldUseTui({ isTTY: true, env: { NO_COLOR: '1' } }), false);
  assert.equal(shouldUseTui({ isTTY: true, env: { CI: 'true' } }), false);
  assert.equal(shouldUseTui({ isTTY: true, env: { TERM: 'dumb' } }), false);
  assert.equal(shouldUseTui({ isTTY: true, env: {} }), true);
  assert.equal(shouldUseTui({ force: true, isTTY: false }), true);
  assert.equal(shouldUseTui({ force: false, isTTY: true, env: {} }), false);
});

test('logoBlock contains angled bracket and zzz brand', () => {
  const plain = logoBlock('status', { color: false });
  // ASCII chevron uses block chars; z's present; optional title
  assert.match(plain, /█|╗|╝|╔/);
  assert.match(plain, /z/i);
  assert.ok((plain.match(/z/gi) || []).length >= 3);
  assert.match(logoLine('setup'), /❯|zzz|unsnooze/i);
});

test('bar and badge are finite ASCII-friendly', () => {
  assert.equal(bar(0, 10, { color: false }).length, 10);
  assert.equal(bar(100, 10, { color: false }).length, 10);
  assert.match(badge('stopped', { color: false }), /STOPPED/);
  assert.match(badge('resumed', { color: false }), /RESUMED/);
  assert.match(badge('failed', { color: false }), /FAILED/);
});

test('countdownPct: due now is full; far future is low', () => {
  const now = 1_000_000;
  assert.equal(countdownPct(now - 1000, now), 100);
  const mid = countdownPct(now + 2.5 * 3_600_000, now, 5 * 3_600_000);
  assert.ok(mid > 40 && mid < 60, `mid=${mid}`);
});

test('formatStatusTui empty and with session', () => {
  const empty = formatStatusTui({
    sessions: [], paused: true, color: false,
    fmtCountdown: () => '1h', fmtResetProvenance: () => 'absolute',
  });
  assert.match(empty, /█|╗|╝|╔|❯/);
  assert.match(empty, /no tracked sessions/);

  const one = formatStatusTui({
    sessions: [{
      key: 'k', status: 'stopped', sessionId: 'abcdef01-rest', agent: 'claude',
      limitType: '5h', cwd: '/tmp/proj', resetAt: Date.now() + 3600_000,
      resetSource: 'absolute', mux: 'tmux', pane: '%1', attempts: 0,
    }],
    resumerPid: 9, color: false,
    fmtCountdown: ms => `${Math.round(ms / 60_000)}m`,
    fmtResetProvenance: () => 'absolute, from hook',
  });
  assert.match(one, /STOPPED/);
  assert.match(one, /abcdef01/);
  assert.match(one, /claude/);
});

test('formatUsageTui includes logo and disclaimer', () => {
  const text = formatUsageTui({
    daemonRunning: true,
    warnAt: [80, 95],
    agents: [{
      agent: 'claude',
      windows: [{
        label: '5h',
        ladder: { tier: 'estimated', pct: null, used: 1000, stopCount: 0 },
        burn: { idle: true, burnPerMin: 0 },
        eta: null,
      }],
    }],
  }, { color: false });
  assert.match(text, /█|╗|╝|╔|❯/);
  assert.match(text, /Z/i);
  assert.ok((text.match(/Z/gi) || []).length >= 3);
  assert.match(text, /lower bound/i);
});

test('formatSessionsTui / doctor / preview empty states', () => {
  assert.match(formatSessionsTui([], { color: false }), /no unsnooze-owned/);
  assert.match(formatDoctorTui({ healthy: true, findings: [] }, { color: false }), /healthy/);
  assert.match(formatDoctorTui({
    healthy: false,
    findings: [{ kind: 'health', title: 'broken hook', detail: 'fix me' }],
  }, { color: false }), /broken hook/);
  assert.match(formatPreviewTui([], { color: false }), /no matching/);
  assert.match(formatPreviewTui([{
    status: 'stopped', id: 'abc', agent: 'claude', cwd: '/t',
    verb: 'would TYPE', gates: ['idle'],
  }], { color: false }), /would TYPE/);
});
