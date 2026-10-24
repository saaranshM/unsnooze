// Stops that reach a Codex rollout only as the failed turn's task_complete
// error — the case behind an OpenAI-compatible proxy, where every token_count
// snapshot has null windows — in a reverted-thread rollout file. End to end
// through the real watcher: file match, parse, dispatch, state record.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-codex-rollout-error-'));
process.env.UNSNOOZE_STATE_DIR = join(DIR, 'state');
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');
process.env.UNSNOOZE_CODEX_DIR = join(DIR, 'codex');
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_MULTIPLEXER = 'headless';
process.env.UNSNOOZE_AUTO_RESUME = 'true';

const { createWatcher, codexSource } = await import('../src/watcher.js');
const { readState } = await import('../src/state.js');
const { dueForDispatch } = await import('../src/resumer.js');
const { RESET_MARGIN_MS } = await import('../src/config.js');
after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

// Verbatim shapes from a ChatGPT desktop app rollout (codex-cli
// 0.155.0-alpha.9.2) written through a proxy: the thread had been reverted
// (hence the "_<rollout id>" filename) and the windows were null on every turn.
const THREAD = '01a0bcf8-f716-7ac3-b90b-5a2cede549a1';
const ROLLOUT = '01a0c026-7b2f-74c3-b576-76743e1da8d7';
const STOPPED = Date.parse('2026-07-23T18:50:34.917Z');
const MESSAGE = "You've hit your usage limit. To get more access now, send a request to your admin or try again at Jul 30th, 2026 10:33 AM.";
const RESET = new Date(2026, 6, 30, 10, 33).getTime();   // the banner is local wall-clock time

function line(payload, at = STOPPED) {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
}
const proxiedSnapshot = line({ type: 'token_count', info: null, rate_limits: {
  limit_id: 'codex', limit_name: null, primary: null, secondary: null, credits: null,
  individual_limit: null, spend_control_reached: null, plan_type: null, rate_limit_reached_type: null,
} }, STOPPED - 2000);
const limitError = line({ type: 'task_complete', turn_id: '019f9050-ae37-74b1-944d-1dc075dbc91e',
  last_agent_message: null, error: { message: MESSAGE, codex_error_info: 'usage_limit_exceeded' }, duration_ms: 492 });
const bare429 = line({ type: 'task_complete', turn_id: '01a0c026-7c61-7fa3-88f7-9b3c5933da9c',
  last_agent_message: null, error: { message: 'exceeded retry limit, last status: 429 Too Many Requests',
    codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } } }, duration_ms: 533 });

function setup(name) {
  const root = join(DIR, name);
  mkdirSync(root);
  const file = join(root, `rollout-2026-09-20T14-49-02-${THREAD}_${ROLLOUT}.jsonl`);
  const meta = JSON.stringify({ timestamp: new Date(STOPPED - 5000).toISOString(), type: 'session_meta',
    payload: { id: THREAD, session_id: THREAD, cwd: root, originator: 'codex_work_desktop',
      cli_version: '0.155.0-alpha.9.2', source: 'vscode', model_provider: 'cpa' } }) + '\n';
  const makeWatcher = extra => createWatcher({
    sources: [codexSource({ roots: [root] })], offsetsPath: join(root, 'offsets.json'),
    now: () => STOPPED + 5000, ...extra,
  });
  return { root, file, meta, makeWatcher };
}

test('a reverted-thread rollout is watched and its usage-limit error is tracked under the thread id', async () => {
  const { root, file, meta, makeWatcher } = setup('reverted');
  writeFileSync(file, meta);
  const watcher = makeWatcher();
  await watcher.tick();
  appendFileSync(file, proxiedSnapshot);
  assert.equal(await watcher.tick(), 0, 'null windows are not a stop');
  appendFileSync(file, limitError);
  assert.equal(await watcher.tick(), 1);
  const record = Object.values(readState().sessions).find(s => s.sessionId === THREAD);
  assert.ok(record, 'tracked under the stable thread id — the id `codex resume` takes');
  assert.equal(record.cwd, root);
  assert.equal(record.status, 'stopped');
  assert.equal(record.origin, 'codex_work_desktop');
  assert.equal(record.detectedVia, 'transcript');
  assert.equal(record.bannerAt, STOPPED);
  assert.equal(record.resetSource, 'absolute');
  assert.equal(record.resetAt, RESET + RESET_MARGIN_MS);
  assert.ok(!dueForDispatch(record.resetAt - 1).some(s => s.sessionId === THREAD));
  assert.ok(dueForDispatch(record.resetAt).some(s => s.sessionId === THREAD));
  appendFileSync(file, limitError);
  assert.equal(await watcher.tick(), 1, 'a re-emitted banner refreshes the tracked stop');
  assert.equal(Object.values(readState().sessions).filter(s => s.sessionId === THREAD).length, 1);
});

test('a bare 429 in the same kind of file is not a stop', async () => {
  const { root, file, meta, makeWatcher } = setup('bare429');
  writeFileSync(file, meta);
  const watcher = makeWatcher();
  await watcher.tick();
  appendFileSync(file, proxiedSnapshot + bare429);
  assert.equal(await watcher.tick(), 0);
  assert.equal(Object.values(readState().sessions).filter(s => s.cwd === root).length, 0);
});

test('a workspace wall and its limit error land as one probed model-limit stop', async () => {
  const thread = '01a0bcf8-0000-7ac3-b90b-00000000a11a';
  const root = join(DIR, 'wall');
  mkdirSync(root);
  const file = join(root, `rollout-2026-09-20T14-49-02-${thread}.jsonl`);
  writeFileSync(file, JSON.stringify({ timestamp: new Date(STOPPED - 5000).toISOString(), type: 'session_meta',
    payload: { id: thread, cwd: root, originator: 'codex_work_desktop' } }) + '\n');
  const watcher = createWatcher({
    sources: [codexSource({ roots: [root] })], offsetsPath: join(root, 'offsets.json'), now: () => STOPPED + 5000,
  });
  await watcher.tick();
  appendFileSync(file, line({ type: 'token_count', info: null, rate_limits: {
    limit_id: 'codex', primary: { used_percent: 97, window_minutes: 300, resets_at: Math.floor(STOPPED / 1000) + 3600 },
    secondary: null, credits: null, plan_type: 'business', rate_limit_reached_type: 'workspace_member_credits_depleted',
  } }, STOPPED - 500) + line({ type: 'task_complete', turn_id: 'x', last_agent_message: null,
    error: { message: 'Your workspace is out of credits. Ask your workspace owner to add more.',
      codex_error_info: 'usage_limit_exceeded' } }));
  assert.equal(await watcher.tick(), 1);
  const record = Object.values(readState().sessions).find(s => s.sessionId === thread);
  assert.equal(record.limitType, 'model');
  assert.equal(record.resetSource, 'fallback', 'probed, never scheduled against a reset that clears nothing');
  assert.equal(record.limitReason, 'workspace_member_credits_depleted');
});

// #50/#49: a multi-agent v2 sub-agent writes its own rollout, whose
// session_meta names the parent thread. Codex refuses to resume the
// sub-agent ("resume the parent first"), so its stop must land on the
// parent's record, never as a second, unresumable one.
test('a sub-agent rollout stop is tracked under its parent thread, merged with the parent stop', async () => {
  const parent = '01a12f81-52a5-78f1-99cc-a7a8d58d18e5';
  const child = '01a1438c-8e5f-7871-b785-aaa3362fffc9';
  const nested = '01a1438c-0000-7871-b785-00000000c0de';
  const root = join(DIR, 'subagent');
  mkdirSync(root);
  const parentFile = join(root, `rollout-2026-10-16T09-10-00-${parent}.jsonl`);
  const childFile = join(root, `rollout-2026-10-16T09-10-47-${child}.jsonl`);
  const nestedFile = join(root, `rollout-2026-10-16T09-11-02-${nested}.jsonl`);
  const metaLine = payload => JSON.stringify({ timestamp: new Date(STOPPED - 5000).toISOString(),
    type: 'session_meta', payload: { cwd: root, originator: 'codex-tui', ...payload } }) + '\n';
  writeFileSync(parentFile, metaLine({ id: parent, session_id: parent }));
  // Top-level parent_thread_id (codex-tui 0.163), and the Desktop shape that
  // only carries it under source.subagent.thread_spawn.
  writeFileSync(childFile, metaLine({ id: child, session_id: parent, parent_thread_id: parent }));
  writeFileSync(nestedFile, metaLine({ id: nested,
    source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } }));
  const watcher = createWatcher({
    sources: [codexSource({ roots: [root] })], offsetsPath: join(root, 'offsets.json'), now: () => STOPPED + 5000,
  });
  await watcher.tick();
  appendFileSync(childFile, limitError);
  appendFileSync(nestedFile, limitError);
  appendFileSync(parentFile, limitError);
  await watcher.tick();
  const tracked = Object.values(readState().sessions).filter(s => s.cwd === root);
  assert.equal(tracked.length, 1, 'one record for one conversation');
  assert.equal(tracked[0].sessionId, parent);
  assert.ok(!tracked.some(s => [child, nested].includes(s.sessionId)));
});
