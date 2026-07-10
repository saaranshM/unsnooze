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

const { createWatcher, claudeSource, claudeDesktopSource, codexSource, dispatchCandidate } = await import('../src/watcher.js');
const { readState, setStatus } = await import('../src/state.js');

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

test('desktop source: sandboxed transcript → origin desktop + CLAUDE_CONFIG_DIR env', async () => {
  // Claude desktop (cowork) layout: each session runs against an isolated
  // CLAUDE_CONFIG_DIR at <...>/local_<id>/.claude with its own projects tree.
  const root = join(DIR, 'd1', 'local-agent-mode-sessions');
  const sandbox = join(root, 'org-uuid', 'sess-uuid', 'local_abc123');
  const projects = join(sandbox, '.claude', 'projects', '-sandbox-outputs');
  mkdirSync(projects, { recursive: true });
  const file = join(projects, 'dddd-1111.jsonl');
  writeFileSync(file, '');

  const stops = [];
  const watcher = createWatcher({
    sources: [claudeDesktopSource({ roots: [root] })],
    offsetsPath: join(DIR, 'd1', 'offsets.json'),
    onStop: rec => stops.push(rec),
  });
  await watcher.tick();
  appendFileSync(file, limitLine({ sessionId: 'desktop-stop', cwd: join(sandbox, 'outputs') }));
  await watcher.tick();

  assert.equal(stops.length, 1);
  assert.equal(stops[0].origin, 'desktop');
  assert.equal(stops[0].sessionId, 'desktop-stop');
  assert.equal(stops[0].cwd, join(sandbox, 'outputs'));
  assert.deepEqual(stops[0].env, { CLAUDE_CONFIG_DIR: join(sandbox, '.claude') });
});

test('dispatchCandidate persists origin and env in the ledger, without a pane key', () => {
  dispatchCandidate({
    agent: 'claude',
    sessionId: 'ledger-stop',
    cwd: '/tmp/proj-ledger',
    limitType: '5h',
    resetLine: SESSION_TEXT,
    resetAt: null,
    origin: 'desktop',
    env: { CLAUDE_CONFIG_DIR: '/tmp/sandbox/.claude' },
    timestampMs: Date.now(),
  });
  const rec = readState().sessions['ledger-stop'];
  assert.ok(rec);
  assert.equal(rec.status, 'stopped');
  assert.equal(rec.detectedVia, 'transcript');
  assert.equal(rec.origin, 'desktop');
  assert.deepEqual(rec.env, { CLAUDE_CONFIG_DIR: '/tmp/sandbox/.claude' });
  assert.ok(!('pane' in rec), 'watcher records must not carry a pane key');
  assert.ok(rec.resetAt > Date.now(), 'reset parsed from the reset line');
});

test('re-emitted stop must not clobber a resuming record or reset attempts', () => {
  const candidate = sid => ({
    agent: 'claude', sessionId: sid, cwd: '/tmp/proj-re', limitType: '5h',
    resetLine: SESSION_TEXT, resetAt: null, origin: 'vscode', timestampMs: Date.now(),
  });
  dispatchCandidate(candidate('re-emit-1'));
  setStatus('re-emit-1', 'resuming', { attempts: 2, lastAttemptAt: Date.now() });

  // The revived CLI writes a fresh limit line → watcher re-emits the stop.
  dispatchCandidate(candidate('re-emit-1'));
  const rec = readState().sessions['re-emit-1'];
  assert.equal(rec.status, 'resuming', 'in-flight resume must not be flipped back to stopped');
  assert.equal(rec.attempts, 2, 'attempts must survive re-emission or MAX_RESUME_ATTEMPTS never binds');
});

test('a cancelled session is not resurrected by a re-emitted stop', () => {
  dispatchCandidate({
    agent: 'claude', sessionId: 'cancel-1', cwd: '/tmp/proj-re', limitType: '5h',
    resetLine: SESSION_TEXT, resetAt: null, origin: 'vscode', timestampMs: Date.now(),
  });
  setStatus('cancel-1', 'cancelled');
  dispatchCandidate({
    agent: 'claude', sessionId: 'cancel-1', cwd: '/tmp/proj-re', limitType: '5h',
    resetLine: SESSION_TEXT, resetAt: null, origin: 'vscode', timestampMs: Date.now(),
  });
  assert.equal(readState().sessions['cancel-1'].status, 'cancelled');
});

test('candidates with unparseable timestamps are dropped, not treated as fresh', async () => {
  const root = join(DIR, 't8', 'projects', '-tmp-proj-w');
  mkdirSync(root, { recursive: true });
  const stops = [];
  const watcher = createWatcher({
    sources: [claudeSource({ roots: [join(DIR, 't8', 'projects')] })],
    offsetsPath: join(DIR, 't8', 'offsets.json'),
    onStop: rec => stops.push(rec),
  });
  const file = join(root, 'hhhh.jsonl');
  writeFileSync(file, '');
  await watcher.tick();
  appendFileSync(file, limitLine({ sessionId: 'bad-ts', timestamp: 'not-a-date' }));
  await watcher.tick();
  assert.equal(stops.length, 0);
});

test('a temporarily disabled source does not lose its offsets', async () => {
  const root = join(DIR, 't9', 'projects', '-tmp-proj-w');
  mkdirSync(root, { recursive: true });
  const stops = [];
  const watcher = createWatcher({
    sources: [claudeSource({ roots: [join(DIR, 't9', 'projects')] })],
    offsetsPath: join(DIR, 't9', 'offsets.json'),
    onStop: rec => stops.push(rec),
  });
  const file = join(root, 'iiii.jsonl');
  writeFileSync(file, limitLine({ sessionId: 'history-stop' }));   // history
  await watcher.tick();                                            // offset at EOF

  process.env.UNSNOOZE_AGENT_CLAUDE = 'off';
  await watcher.tick();                                            // source skipped
  process.env.UNSNOOZE_AGENT_CLAUDE = 'on';
  await watcher.tick();
  assert.equal(stops.length, 0, 'history must not replay after a disable/enable cycle');

  appendFileSync(file, limitLine({ sessionId: 'post-toggle-stop' }));
  await watcher.tick();
  delete process.env.UNSNOOZE_AGENT_CLAUDE;
  assert.equal(stops.length, 1);
  assert.equal(stops[0].sessionId, 'post-toggle-stop');
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
