// Monitor detection loop against fixture pane text, with fake tmux.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-detect-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';   // no desktop popups from tests
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');   // no transcripts → no backfill

const { createMonitor } = await import('../src/monitor.js');
const { readState, upsertSession } = await import('../src/state.js');
const { dashCwd } = await import('../src/sessions.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

function fakeTmux(script) {
  const sent = [];
  return {
    sent,
    paneAlive: async () => script.alive ?? true,
    capturePane: async () => script.text,
    sendText: async (pane, text) => sent.push({ type: 'text', text }),
    sendKey: async (pane, key) => sent.push({ type: 'key', key }),
  };
}

// Absolute time always ~3h in the future in UTC so first-tick corroboration
// (§6) accepts it regardless of when the suite runs.
function futureBanner(hoursAhead = 3) {
  const d = new Date(Date.now() + hoursAhead * 3_600_000);
  const h24 = d.getUTCHours();
  const m = d.getUTCMinutes();
  const h12 = h24 % 12 || 12;
  const ampm = h24 < 12 ? 'am' : 'pm';
  const time = m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
  return [
    '⏺ working...',
    "⚠ You've hit your 5-hour limit",
    `· resets ${time} (UTC)`,
    '> ',
  ].join('\n');
}

const BANNER = futureBanner(3);

// Relative-only / unparseable banners are NOT corroborated on first tick.
const RELATIVE_BANNER = [
  '⏺ working...',
  "⚠ You've hit your 5-hour limit",
  '· resets in 2 hours',
  '> ',
].join('\n');

// Matches grok's LIMIT_ANCHORS (resetPatterns include the same anchors).
const UNPARSEABLE_BANNER = [
  'Rate limit exceeded. Please wait a moment and try again.',
  '> ',
].join('\n');

async function grokAgent() {
  const { patterns } = await import('../src/agents/grok.js');
  return {
    id: 'grok', name: 'Grok',
    patterns,
    menu: null,
    latestSessionId: () => null,
    isForegroundCommand: () => true,
  };
}

test('monitor tick records a limit stop from a live banner', async () => {
  const notes = [];
  const tmux = fakeTmux({ text: BANNER });
  const monitor = createMonitor({
    pane: '%50', cwd: '/tmp/proj-a', mux: tmux,
    notifier: (t, m, opts) => notes.push({ t, m, opts }),
  });
  await monitor._tick();
  const recs = Object.values(readState().sessions).filter(s => s.pane === '%50');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].status, 'stopped');
  assert.equal(recs[0].limitType, '5h');
  assert.equal(recs[0].resetSource, 'absolute');
  assert.ok(recs[0].resetAt > Date.now());
  assert.equal(notes.length, 1);
  assert.match(notes[0].t, /hit a usage limit/);
  assert.deepEqual(notes[0].opts?.context, { mux: 'tmux', pane: '%50', paneOwner: null });
});

test('repeat ticks do not duplicate the record', async () => {
  const tmux = fakeTmux({ text: BANNER });
  const monitor = createMonitor({ pane: '%51', cwd: '/tmp/proj-b', mux: tmux });
  await monitor._tick();
  await monitor._tick();
  await monitor._tick();
  const recs = Object.values(readState().sessions).filter(s => s.pane === '%51');
  assert.equal(recs.length, 1);
});

test('clean pane records nothing', async () => {
  const tmux = fakeTmux({ text: 'all good\n> ' });
  const monitor = createMonitor({ pane: '%52', cwd: '/tmp/proj-c', mux: tmux });
  await monitor._tick();
  assert.equal(Object.values(readState().sessions).filter(s => s.pane === '%52').length, 0);
});

test('menu is driven to "Stop and wait", never blind Enter', async () => {
  const MENU = [
    'What do you want to do?',
    '❯ 1. Upgrade your plan',
    '  2. Stop and wait for limit to reset',
    '(enter to confirm)',
  ].join('\n');
  const tmux = fakeTmux({ text: MENU });
  const monitor = createMonitor({ pane: '%53', cwd: '/tmp/proj-d', mux: tmux });
  await monitor._tick();
  assert.deepEqual(tmux.sent.map(s => s.key), ['Down', 'Enter']);
});

test('menu detection uses the VISIBLE screen, not scrollback history', async () => {
  // Regression: an answered menu lingers in tmux history; scanning history
  // made the monitor re-drive the menu (stray keystrokes) forever.
  const MENU_IN_HISTORY = [
    'What do you want to do?',
    '❯ 1. Upgrade your plan',
    '  2. Stop and wait for limit to reset',
    '(enter to confirm)',
    'CHOSE: 2. Stop and wait for limit to reset',
    "⚠ You've hit your 5-hour limit",
    ...BANNER.split('\n').slice(2),
  ].join('\n');
  const VISIBLE_NOW = [
    'CHOSE: 2. Stop and wait for limit to reset',
    "⚠ You've hit your 5-hour limit",
    ...BANNER.split('\n').slice(2),
  ].join('\n');
  const sent = [];
  const tmux = {
    paneAlive: async () => true,
    capturePane: async () => MENU_IN_HISTORY,          // full capture incl. history
    capturePaneVisible: async () => VISIBLE_NOW,       // what's actually on screen
    sendText: async (pane, text) => sent.push({ type: 'text', text }),
    sendKey: async (pane, key) => sent.push({ type: 'key', key }),
  };
  const monitor = createMonitor({ pane: '%55', cwd: '/tmp/proj-f', mux: tmux });
  await monitor._tick();
  assert.equal(sent.length, 0, 'must NOT re-drive a menu that is only in history');
  const recs = Object.values(readState().sessions).filter(s => s.pane === '%55');
  assert.equal(recs.length, 1, 'the banner on the visible screen must be recorded');
  assert.equal(recs[0].status, 'stopped');
});

test('banner cleared + tracked → record flips to resumed', async () => {
  const script = { text: BANNER };
  const tmux = fakeTmux(script);
  const monitor = createMonitor({ pane: '%54', cwd: '/tmp/proj-e', mux: tmux });
  await monitor._tick();               // records stop
  script.text = '⏺ working again… (esc to interrupt)';
  await monitor._tick();               // sees banner gone
  const recs = Object.values(readState().sessions).filter(s => s.pane === '%54');
  assert.equal(recs[0].status, 'resumed');
});

// --- terminalPatterns: non-resetting errors notify once, never touch the ledger ---

test('terminal pattern notifies once and records nothing', async () => {
  const notes = [];
  const agent = {
    id: 'kimi', name: 'Kimi CLI',
    patterns: {
      limitPatterns: [/rate_limit_reached_error/i],
      resetPatterns: [/rate_limit_reached_error/i],
      weeklyPatterns: [], fiveHourPatterns: [],
      busyPatterns: [], idleRegex: />/,
      overloadPatterns: [],
      terminalPatterns: [/Membership expired/i],
    },
    menu: null,
    latestSessionId: () => null,
    isForegroundCommand: () => true,
  };
  const tmux = fakeTmux({ text: 'Membership expired, please renew your plan\n> \n' });
  const monitor = createMonitor({
    pane: '%60', cwd: '/tmp/proj-t', mux: tmux, agent,
    notifier: (t, m, opts) => notes.push({ t, m, opts }),
  });
  await monitor._tick();
  await monitor._tick();
  await monitor._tick();
  const recs = Object.values(readState().sessions).filter(s => s.pane === '%60');
  assert.equal(recs.length, 0, 'terminal errors must not create ledger records');
  assert.equal(notes.length, 1, 'exactly one notification across repeat ticks');
  assert.match(notes[0].m, /Membership expired/);
  assert.deepEqual(notes[0].opts?.context, { mux: 'tmux', pane: '%60', paneOwner: null });
});

test('terminal notification re-arms after the banner clears', async () => {
  const notes = [];
  const agent = {
    id: 'kimi', name: 'Kimi CLI',
    patterns: {
      limitPatterns: [/rate_limit_reached_error/i],
      resetPatterns: [/rate_limit_reached_error/i],
      weeklyPatterns: [], fiveHourPatterns: [],
      busyPatterns: [], idleRegex: />/,
      overloadPatterns: [],
      terminalPatterns: [/Membership expired/i],
    },
    menu: null,
    latestSessionId: () => null,
    isForegroundCommand: () => true,
  };
  const script = { text: 'Membership expired, please renew your plan\n> \n' };
  const tmux = fakeTmux(script);
  const monitor = createMonitor({
    pane: '%61', cwd: '/tmp/proj-u', mux: tmux, agent,
    notifier: (t, m, opts) => notes.push({ t, m, opts }),
  });
  await monitor._tick();
  script.text = 'all good\n> \n';
  await monitor._tick();
  script.text = 'Membership expired, please renew your plan\n> \n';
  await monitor._tick();
  assert.equal(notes.length, 2, 'clears then re-notifies on a fresh terminal error');
  for (const n of notes) {
    assert.deepEqual(n.opts?.context, { mux: 'tmux', pane: '%61', paneOwner: null });
  }
});

test('resumed record ignores stale banner until this monitor observes it clear', async () => {
  const script = { text: BANNER };
  const mux = fakeTmux(script);
  const monitor = createMonitor({ pane: '%56', cwd: '/tmp/proj-edge', mux });
  await monitor._tick();
  const key = Object.values(readState().sessions).find(s => s.pane === '%56').key;
  const { setStatus } = await import('../src/state.js');
  setStatus(key, 'resumed', { bannerCleared: false, attempts: 3 });
  await monitor._tick();
  assert.equal(readState().sessions[key].status, 'resumed');
  assert.equal(readState().sessions[key].attempts, 3);
  script.text = 'working again';
  await monitor._tick();
  assert.equal(readState().sessions[key].bannerCleared, true);
});

// --- §6 first-tick guard ---

test('first tick with uncorroborated relative banner → no record', async () => {
  const tmux = fakeTmux({ text: RELATIVE_BANNER });
  const monitor = createMonitor({ pane: '%70', cwd: '/tmp/proj-stale', mux: tmux });
  await monitor._tick();
  assert.equal(
    Object.values(readState().sessions).filter(s => s.pane === '%70').length,
    0,
    'first tick must not inherit a relative-only leftover banner',
  );
});

test('first tick with unparseable banner → no record; second tick records (probe)', async () => {
  const tmux = fakeTmux({ text: UNPARSEABLE_BANNER });
  const agent = await grokAgent();
  const monitor = createMonitor({ pane: '%71', cwd: '/tmp/proj-grok', mux: tmux, agent });
  await monitor._tick();
  assert.equal(Object.values(readState().sessions).filter(s => s.pane === '%71').length, 0);
  await monitor._tick();
  const recs = Object.values(readState().sessions).filter(s => s.pane === '%71');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].resetSource, 'fallback');
  // Probe interval (~15 min), not 5h
  const wait = recs[0].resetAt - recs[0].detectedAt;
  assert.ok(wait < 30 * 60_000, `expected probe-scale wait, got ${wait}ms`);
});

test('first tick with absolute future banner is corroborated and recorded', async () => {
  const tmux = fakeTmux({ text: BANNER });
  const monitor = createMonitor({ pane: '%72', cwd: '/tmp/proj-abs', mux: tmux });
  await monitor._tick();
  const recs = Object.values(readState().sessions).filter(s => s.pane === '%72');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].resetSource, 'absolute');
});

// --- §7 upgrade weak estimates ---

test('monitor upgrades fallback→absolute on subsequent tick', async () => {
  // Use grok so unparseable "Rate limit exceeded" is a real hit; then swap
  // the pane text to an absolute future banner for the upgrade.
  const agent = await grokAgent();
  const claudePatterns = (await import('../src/agents/claude.js')).patterns;
  const script = { text: UNPARSEABLE_BANNER };
  const tmux = fakeTmux(script);
  const monitor = createMonitor({ pane: '%82', cwd: '/tmp/proj-up3', mux: tmux, agent });
  await monitor._tick(); // first: skip uncorroborated
  await monitor._tick(); // second: record fallback
  let rec = Object.values(readState().sessions).find(s => s.pane === '%82');
  assert.ok(rec, 'fallback record should exist after second tick');
  assert.equal(rec.resetSource, 'fallback');
  const fallbackAt = rec.resetAt;

  // Absolute banner needs claude-style resetPatterns ("resets 3pm") — switch
  // agent patterns for the upgrade scrape by mutating the shared agent object.
  agent.patterns = claudePatterns;
  script.text = BANNER;
  await monitor._tick(); // third: upgrade to absolute
  rec = Object.values(readState().sessions).find(s => s.pane === '%82');
  assert.equal(rec.resetSource, 'absolute', 'better source must replace the probe guess');
  // Absolute truth may be later than a short probe interval — that's fine;
  // same-or-worse sources are the ones forbidden from pushing later.
  assert.ok(rec.resetAt > Date.now(), 'absolute reset should be in the future');
  assert.notEqual(rec.resetAt, fallbackAt);
});

// --- §2 transcript path ---

test('monitor prefers fresh transcript rate-limit over pane scrape', async () => {
  const cwd = '/tmp/proj-tx';
  const sessionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const projectDir = join(DIR, 'claude', 'projects', dashCwd(cwd));
  mkdirSync(projectDir, { recursive: true });

  // Transcript holds a future absolute time (dated). Pane holds the same hit
  // so detectLimit fires; resolveBanner should prefer the transcript.
  const future = new Date(Date.now() + 3 * 3_600_000);
  const h24 = future.getUTCHours();
  const m = future.getUTCMinutes();
  const h12 = h24 % 12 || 12;
  const ampm = h24 < 12 ? 'am' : 'pm';
  const time = m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
  const liveText = `You've hit your session limit · resets ${time} (UTC)`;
  const entry = {
    isSidechain: false,
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: liveText }] },
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    cwd,
    sessionId,
  };
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), JSON.stringify(entry) + '\n');

  // Pane shows a weaker relative form; transcript absolute must win.
  const paneText = [
    "⚠ You've hit your 5-hour limit",
    '· resets in 4 hours',
    '> ',
  ].join('\n');
  const tmux = fakeTmux({ text: paneText });
  const monitor = createMonitor({
    pane: '%90', cwd, mux: tmux,
    agent: {
      id: 'claude', name: 'Claude',
      patterns: (await import('../src/agents/claude.js')).patterns,
      menu: null,
      latestSessionId: () => sessionId,
      isForegroundCommand: () => true,
    },
  });
  await monitor._tick();
  const rec = Object.values(readState().sessions).find(s => s.pane === '%90');
  assert.ok(rec, 'should record from transcript corroboration');
  assert.equal(rec.resetSource, 'absolute');
  assert.equal(rec.detectedVia, 'transcript');
  assert.ok(rec.bannerAt != null);
});