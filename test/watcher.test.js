// Watcher runner: offset-tailing of session files across watch roots.
// Semantics under test:
//  - first sight of an existing file initializes its offset at EOF (history is
//    never replayed as fresh stops)
//  - files created after the first tick are read from byte 0
//  - only complete (newline-terminated) lines are parsed; a partial tail line
//    waits for its newline
//  - offsets persist across watcher instances via the offsets file
//  - shrunk/rewritten files reset to EOF instead of replaying
//  - stale entries (older than freshnessMs) are dropped
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-watcher-test-'));
process.env.UNSNOOZE_STATE_DIR = join(DIR, 'state');
process.env.UNSNOOZE_NOTIFICATIONS = 'off';

const { createWatcher, claudeSource, codexSource } = await import('../src/watcher.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

const SESSION_TEXT = "You've hit your session limit · resets 6:40pm (Asia/Calcutta)";

function limitLine(overrides = {}) {
  return JSON.stringify({
    isSidechain: false,
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: SESSION_TEXT }] },
    error: 'rate_limit',
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    entrypoint: 'cli',
    cwd: '/tmp/proj-w',
    sessionId: 'watched-1',
    ...overrides,
  }) + '\n';
}

function newSetup(name) {
  const root = join(DIR, name, 'projects', '-tmp-proj-w');
  mkdirSync(root, { recursive: true });
  const stops = [];
  const watcher = createWatcher({
    sources: [claudeSource({ roots: [join(DIR, name, 'projects')] })],
    offsetsPath: join(DIR, name, 'offsets.json'),
    onStop: rec => stops.push(rec),
  });
  return { root, stops, watcher, offsetsPath: join(DIR, name, 'offsets.json') };
}

test('history in already-existing files is not replayed; fresh appends are parsed', async () => {
  const { root, stops, watcher } = newSetup('t1');
  const file = join(root, 'aaaa.jsonl');
  writeFileSync(file, limitLine({ sessionId: 'old-stop' }));   // history

  await watcher.tick();
  assert.equal(stops.length, 0, 'first tick must not replay history');

  appendFileSync(file, limitLine({ sessionId: 'fresh-stop' }));
  await watcher.tick();
  assert.equal(stops.length, 1);
  assert.equal(stops[0].sessionId, 'fresh-stop');
  assert.equal(stops[0].agent, 'claude');
  assert.equal(stops[0].cwd, '/tmp/proj-w');
  assert.equal(stops[0].limitType, '5h');
  assert.equal(stops[0].resetLine, SESSION_TEXT);
  assert.equal(stops[0].origin, 'cli');

  // Same content, no growth → nothing new.
  await watcher.tick();
  assert.equal(stops.length, 1);
});

test('files created after the first tick are read from the start', async () => {
  const { root, stops, watcher } = newSetup('t2');
  await watcher.tick();                                        // establish first-tick baseline
  const file = join(root, 'bbbb.jsonl');
  writeFileSync(file, limitLine({ sessionId: 'new-file-stop' }));
  await watcher.tick();
  assert.equal(stops.length, 1);
  assert.equal(stops[0].sessionId, 'new-file-stop');
});

test('a partial (unterminated) line waits for its newline', async () => {
  const { root, stops, watcher } = newSetup('t3');
  const file = join(root, 'cccc.jsonl');
  writeFileSync(file, '');
  await watcher.tick();

  const full = limitLine({ sessionId: 'split-stop' });
  const cut = Math.floor(full.length / 2);
  appendFileSync(file, full.slice(0, cut));
  await watcher.tick();
  assert.equal(stops.length, 0, 'half a line must not parse');

  appendFileSync(file, full.slice(cut));
  await watcher.tick();
  assert.equal(stops.length, 1);
  assert.equal(stops[0].sessionId, 'split-stop');
});

test('offsets persist across watcher instances', async () => {
  const { root, stops, watcher, offsetsPath } = newSetup('t4');
  const file = join(root, 'dddd.jsonl');
  writeFileSync(file, '');
  await watcher.tick();
  appendFileSync(file, limitLine({ sessionId: 'seen-once' }));
  await watcher.tick();
  assert.equal(stops.length, 1);

  // A new instance with the same offsets file must not replay the stop.
  const stops2 = [];
  const watcher2 = createWatcher({
    sources: [claudeSource({ roots: [join(DIR, 't4', 'projects')] })],
    offsetsPath,
    onStop: rec => stops2.push(rec),
  });
  await watcher2.tick();
  assert.equal(stops2.length, 0);
});

test('a shrunk (rewritten) file resets to EOF instead of replaying', async () => {
  const { root, stops, watcher } = newSetup('t5');
  const file = join(root, 'eeee.jsonl');
  writeFileSync(file, limitLine({ sessionId: 'x1' }) + limitLine({ sessionId: 'x2' }));
  await watcher.tick();                                        // offset at EOF
  truncateSync(file, 10);                                      // rewritten shorter
  await watcher.tick();
  assert.equal(stops.length, 0);
  appendFileSync(file, '\n' + limitLine({ sessionId: 'after-truncate' }));
  await watcher.tick();
  assert.equal(stops.length, 1);
  assert.equal(stops[0].sessionId, 'after-truncate');
});

test('subagent transcripts are excluded', async () => {
  const { root, stops, watcher } = newSetup('t6');
  const sub = join(root, 'ffff', 'subagents');
  mkdirSync(sub, { recursive: true });
  const file = join(sub, 'agent-a1.jsonl');
  writeFileSync(file, '');
  await watcher.tick();
  appendFileSync(file, limitLine({ sessionId: 'subagent-stop' }));
  await watcher.tick();
  assert.equal(stops.length, 0);
});

test('stale entries older than freshnessMs are dropped', async () => {
  const root = join(DIR, 't7', 'projects', '-tmp-proj-w');
  mkdirSync(root, { recursive: true });
  const stops = [];
  const watcher = createWatcher({
    sources: [claudeSource({ roots: [join(DIR, 't7', 'projects')] })],
    offsetsPath: join(DIR, 't7', 'offsets.json'),
    freshnessMs: 60_000,
    onStop: rec => stops.push(rec),
  });
  const file = join(root, 'gggg.jsonl');
  writeFileSync(file, '');
  await watcher.tick();
  appendFileSync(file, limitLine({ sessionId: 'stale-stop', timestamp: new Date(Date.now() - 3_600_000).toISOString() }));
  await watcher.tick();
  assert.equal(stops.length, 0);
});

test('codex source: exhausted token_count in a fresh rollout → candidate with epoch reset', async () => {
  const sessions = join(DIR, 'c1', 'sessions', '2026', '07', '10');
  mkdirSync(sessions, { recursive: true });
  const id = '019e2001-9214-74e0-9afb-f0ec217b794d';
  const file = join(sessions, `rollout-2026-07-10T10-00-00-${id}.jsonl`);
  const meta = JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'session_meta',
    payload: { id, cwd: '/tmp/proj-codex', originator: 'codex-tui', source: 'cli' },
  });
  writeFileSync(file, meta + '\n');

  const stops = [];
  const watcher = createWatcher({
    sources: [codexSource({ roots: [join(DIR, 'c1', 'sessions')] })],
    offsetsPath: join(DIR, 'c1', 'offsets.json'),
    onStop: rec => stops.push(rec),
  });
  await watcher.tick();

  const resetsAt = Math.floor(Date.now() / 1000) + 7200;
  appendFileSync(file, JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: {
        primary: { used_percent: 100, window_minutes: 300, resets_at: resetsAt },
        secondary: { used_percent: 12, window_minutes: 10080, resets_at: resetsAt + 999 },
        rate_limit_reached_type: null,
      },
    },
  }) + '\n');
  await watcher.tick();

  assert.equal(stops.length, 1);
  assert.equal(stops[0].agent, 'codex');
  assert.equal(stops[0].sessionId, id);
  assert.equal(stops[0].cwd, '/tmp/proj-codex');
  assert.equal(stops[0].limitType, '5h');
  assert.equal(stops[0].resetAt, resetsAt * 1000);
  assert.equal(stops[0].origin, 'codex-tui');
});
