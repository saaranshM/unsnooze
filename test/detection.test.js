// Monitor detection loop against fixture pane text, with fake tmux.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-detect-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');   // no transcripts → no backfill

const { createMonitor } = await import('../src/monitor.js');
const { readState } = await import('../src/state.js');

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

const BANNER = [
  '⏺ working...',
  "⚠ You've hit your 5-hour limit",
  '· resets 3pm (UTC)',
  '> ',
].join('\n');

test('monitor tick records a limit stop from a live banner', async () => {
  const tmux = fakeTmux({ text: BANNER });
  const monitor = createMonitor({ pane: '%50', cwd: '/tmp/proj-a', tmux });
  await monitor._tick();
  const recs = Object.values(readState().sessions).filter(s => s.pane === '%50');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].status, 'stopped');
  assert.equal(recs[0].limitType, '5h');
  assert.equal(recs[0].resetSource, 'absolute');
  assert.ok(recs[0].resetAt > Date.now());
});

test('repeat ticks do not duplicate the record', async () => {
  const tmux = fakeTmux({ text: BANNER });
  const monitor = createMonitor({ pane: '%51', cwd: '/tmp/proj-b', tmux });
  await monitor._tick();
  await monitor._tick();
  await monitor._tick();
  const recs = Object.values(readState().sessions).filter(s => s.pane === '%51');
  assert.equal(recs.length, 1);
});

test('clean pane records nothing', async () => {
  const tmux = fakeTmux({ text: 'all good\n> ' });
  const monitor = createMonitor({ pane: '%52', cwd: '/tmp/proj-c', tmux });
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
  const monitor = createMonitor({ pane: '%53', cwd: '/tmp/proj-d', tmux });
  await monitor._tick();
  assert.deepEqual(tmux.sent.map(s => s.key), ['Down', 'Enter']);
});

test('banner cleared + tracked → record flips to resumed', async () => {
  const script = { text: BANNER };
  const tmux = fakeTmux(script);
  const monitor = createMonitor({ pane: '%54', cwd: '/tmp/proj-e', tmux });
  await monitor._tick();               // records stop
  script.text = '⏺ working again… (esc to interrupt)';
  await monitor._tick();               // sees banner gone
  const recs = Object.values(readState().sessions).filter(s => s.pane === '%54');
  assert.equal(recs[0].status, 'resumed');
});
