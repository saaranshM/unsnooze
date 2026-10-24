// Codex rollout-line parser: every turn writes token_count events carrying a
// rate_limits snapshot with used_percent + resets_at epochs, and (since
// codex-cli 0.145) a failed turn's task_complete carries the error with the
// banner text. Fixture shapes captured from real ~/.codex/sessions rollouts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRolloutLine, parseRolloutLines, rolloutMeta } from '../src/watchers/codex.js';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-codex-watch-test-'));
after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const TS = '2026-05-13T06:37:10.065Z';
const RESETS_PRIMARY = 1778672230;    // epoch seconds
const RESETS_SECONDARY = 1778674736;

function tokenCountLine(rateLimits) {
  return JSON.stringify({
    timestamp: TS,
    type: 'event_msg',
    payload: { type: 'token_count', info: null, rate_limits: rateLimits },
  });
}

function rateLimits(overrides = {}) {
  return {
    limit_id: 'codex',
    limit_name: null,
    primary: { used_percent: 1.0, window_minutes: 300, resets_at: RESETS_PRIMARY },
    secondary: { used_percent: 1.0, window_minutes: 10080, resets_at: RESETS_SECONDARY },
    credits: null,
    plan_type: 'plus',
    rate_limit_reached_type: null,
    ...overrides,
  };
}

test('healthy token_count (low usage, no reached type) → null', () => {
  assert.equal(parseRolloutLine(tokenCountLine(rateLimits())), null);
});

test('primary window exhausted → 5h limit with epoch reset', () => {
  const rec = parseRolloutLine(tokenCountLine(rateLimits({
    primary: { used_percent: 100, window_minutes: 300, resets_at: RESETS_PRIMARY },
  })));
  assert.ok(rec);
  assert.equal(rec.limitType, '5h');
  assert.equal(rec.resetAt, RESETS_PRIMARY * 1000);
  assert.equal(rec.timestampMs, Date.parse(TS));
});

test('secondary window exhausted → weekly limit', () => {
  const rec = parseRolloutLine(tokenCountLine(rateLimits({
    secondary: { used_percent: 100, window_minutes: 10080, resets_at: RESETS_SECONDARY },
  })));
  assert.ok(rec);
  assert.equal(rec.limitType, 'weekly');
  assert.equal(rec.resetAt, RESETS_SECONDARY * 1000);
});

test('both windows exhausted → the later reset binds (weekly)', () => {
  const rec = parseRolloutLine(tokenCountLine(rateLimits({
    primary: { used_percent: 100, window_minutes: 300, resets_at: RESETS_PRIMARY },
    secondary: { used_percent: 100, window_minutes: 10080, resets_at: RESETS_SECONDARY },
  })));
  assert.ok(rec);
  assert.equal(rec.resetAt, RESETS_SECONDARY * 1000);
  assert.equal(rec.limitType, 'weekly');
});

test('rate_limit_reached_type set → hit even below 100%', () => {
  const rec = parseRolloutLine(tokenCountLine(rateLimits({
    primary: { used_percent: 99.2, window_minutes: 300, resets_at: RESETS_PRIMARY },
    rate_limit_reached_type: 'primary',
  })));
  assert.ok(rec);
  assert.equal(rec.limitType, '5h');
  assert.equal(rec.resetAt, RESETS_PRIMARY * 1000);
});

test('non-token_count and malformed lines → null', () => {
  assert.equal(parseRolloutLine(JSON.stringify({ timestamp: TS, type: 'response_item', payload: {} })), null);
  assert.equal(parseRolloutLine(JSON.stringify({ timestamp: TS, type: 'event_msg', payload: { type: 'agent_message' } })), null);
  assert.equal(parseRolloutLine('{{ not json'), null);
  assert.equal(parseRolloutLine(''), null);
  // token_count without rate_limits (older builds)
  assert.equal(parseRolloutLine(JSON.stringify({ timestamp: TS, type: 'event_msg', payload: { type: 'token_count', info: null } })), null);
});

test('rolloutMeta reads sessionId/cwd/originator from the session_meta head', () => {
  const id = '019e2001-9214-74e0-9afb-f0ec217b794d';
  const path = join(DIR, `rollout-2026-05-13T11-53-54-${id}.jsonl`);
  const meta = {
    timestamp: TS,
    type: 'session_meta',
    payload: { id, timestamp: TS, cwd: '/tmp/proj-codex', originator: 'codex-tui', cli_version: '0.130.0', source: 'cli' },
  };
  writeFileSync(path, JSON.stringify(meta) + '\n' + tokenCountLine(rateLimits()) + '\n');
  const info = rolloutMeta(path);
  assert.equal(info.sessionId, id);
  assert.equal(info.cwd, '/tmp/proj-codex');
  assert.equal(info.originator, 'codex-tui');
});

test('rolloutMeta falls back to the filename uuid when the head is unreadable', () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const path = join(DIR, `rollout-2026-05-13T11-53-54-${id}.jsonl`);
  writeFileSync(path, 'garbage not json\n');
  const info = rolloutMeta(path);
  assert.equal(info.sessionId, id);
  assert.equal(info.cwd, null);
});

// --- unified ChatGPT app rollout format (codex-cli 0.144, verified live) ---
// New additive fields: limit_id, limit_name, credits, individual_limit,
// plan_type; secondary can be null. Wrapper structure is unchanged.

const UNIFIED_OK = JSON.stringify({
  timestamp: '2026-07-12T15:42:31.000Z', type: 'event_msg',
  payload: { type: 'token_count', rate_limits: {
    limit_id: 'codex', limit_name: null,
    primary: { used_percent: 5.0, window_minutes: 43200, resets_at: 1786462931 },
    secondary: null,
    credits: { has_credits: false, unlimited: false, balance: null },
    individual_limit: null, plan_type: 'go', rate_limit_reached_type: null,
  } },
});

const UNIFIED_EXHAUSTED = JSON.stringify({
  timestamp: '2026-07-12T15:42:31.000Z', type: 'event_msg',
  payload: { type: 'token_count', rate_limits: {
    limit_id: 'codex', limit_name: null,
    primary: { used_percent: 100, window_minutes: 43200, resets_at: 1786462931 },
    secondary: null,
    credits: { has_credits: false, unlimited: false, balance: null },
    individual_limit: null, plan_type: 'go', rate_limit_reached_type: 'primary',
  } },
});

test('unified-app snapshot below the limit is not a candidate', () => {
  assert.equal(parseRolloutLine(UNIFIED_OK), null);
});

test('unified-app exhausted window parses with epoch reset and long-window type', () => {
  const c = parseRolloutLine(UNIFIED_EXHAUSTED);
  assert.ok(c);
  assert.equal(c.resetAt, 1786462931 * 1000);
  assert.equal(c.limitType, '30d');   // label from minutes — go-plan 43200 is monthly, not weekly
});

test('unified-app session_meta head still yields id/cwd/originator', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-unified-meta-'));
  const p = join(dir, 'rollout-2026-07-12T21-12-08-019f56fe-3508-7f10-8bb2-5e1db403916f.jsonl');
  writeFileSync(p, JSON.stringify({
    timestamp: '2026-07-12T15:42:08.174Z', type: 'session_meta',
    payload: {
      session_id: '019f56fe-3508-7f10-8bb2-5e1db403916f', id: '019f56fe-3508-7f10-8bb2-5e1db403916f',
      cwd: '/tmp/probe', originator: 'codex_exec', cli_version: '0.144.0-alpha.4',
      source: 'exec', thread_source: 'user', model_provider: 'openai',
    },
  }) + '\n');
  const meta = rolloutMeta(p);
  assert.equal(meta.sessionId, '019f56fe-3508-7f10-8bb2-5e1db403916f');
  assert.equal(meta.cwd, '/tmp/probe');
  assert.equal(meta.originator, 'codex_exec');
});

// rate_limit_reached_type is a REASON (rate_limit_reached, workspace_owner_
// usage_limit_reached, …), never a window name. What it binds to:
//   - an exhausted window (>= 100) always wins — the latest reset governs;
//   - a plain rate_limit_reached with nothing at 100 binds the window nearest
//     exhaustion (the server reports fractions; #20's real stop read 99.0).
//     Binding the LATEST reset here scheduled a 99.x% five-hour stop for the
//     weekly reset, days out;
//   - a workspace_* reason with nothing at 100 is a wall no window reset
//     takes down (out of credits, workspace cap). It gets no reset time, so
//     the resumer probes and, at the ceiling, names the remedy instead of
//     sleeping for a week and waking into the same wall (#25).
function reached(type, primary, secondary) {
  return JSON.stringify({
    timestamp: '2026-07-12T15:42:31.000Z', type: 'event_msg',
    payload: { type: 'token_count', rate_limits: {
      limit_id: 'codex',
      primary: { used_percent: primary, window_minutes: 300, resets_at: 1786400000 },
      secondary: { used_percent: secondary, window_minutes: 10080, resets_at: 1786462931 },
      plan_type: 'business', rate_limit_reached_type: type,
    } },
  });
}

test('rate_limit_reached below 100% binds the window nearest exhaustion, not the latest reset', () => {
  const fiveHour = parseRolloutLine(reached('rate_limit_reached', 99.6, 40));
  assert.equal(fiveHour.limitType, '5h');
  assert.equal(fiveHour.resetAt, 1786400000 * 1000);
  assert.equal(fiveHour.reachedType, 'rate_limit_reached');
  const weekly = parseRolloutLine(reached('rate_limit_reached', 40, 99.5));
  assert.equal(weekly.limitType, 'weekly');
  assert.equal(weekly.resetAt, 1786462931 * 1000);
  // A tie goes to the primary — the shorter wait.
  assert.equal(parseRolloutLine(reached('rate_limit_reached', 99, 99)).limitType, '5h');
});

test('a workspace wall with no spent window has no reset to wait for', () => {
  for (const type of ['workspace_owner_credits_depleted', 'workspace_member_credits_depleted',
    'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached']) {
    const c = parseRolloutLine(reached(type, 97, 60));
    assert.ok(c, `${type} is still a stop`);
    assert.equal(c.limitType, 'model', type);
    assert.equal(c.resetAt, null, type);
    assert.equal(c.reachedType, type);
    assert.equal(c.timestampMs, Date.parse('2026-07-12T15:42:31.000Z'));
  }
});

test('a credits-only bucket carrying a workspace reason is not a stop of its own', () => {
  // The account bucket's line, 0.6s earlier, already recorded the real stop;
  // this one describes no window and must not re-file it as a probe.
  const line = JSON.stringify({
    timestamp: '2026-07-12T15:42:31.600Z', type: 'event_msg',
    payload: { type: 'token_count', rate_limits: {
      limit_id: 'premium', primary: null, secondary: null,
      credits: { has_credits: false, unlimited: false, balance: '0' },
      plan_type: 'business', rate_limit_reached_type: 'workspace_member_credits_depleted',
    } },
  });
  assert.equal(parseRolloutLine(line), null);
});

test('an exhausted window still governs when a workspace reason rides along', () => {
  // #25: primary at 100 plus workspace_member_credits_depleted. The window
  // reset is what brings the plan allowance back, so it stays a waitable 5h
  // stop rather than a wall held for a human.
  const c = parseRolloutLine(reached('workspace_member_credits_depleted', 100, 40));
  assert.equal(c.limitType, '5h');
  assert.equal(c.resetAt, 1786400000 * 1000);
  assert.equal(c.reachedType, 'workspace_member_credits_depleted');
});

// The server reports fractions, and a real stop has read 99.0 (#20): a window
// at 99.x% is as spent as one at 100. Treating it as a wall held the same stop
// for a human that one tenth of a percent later was a waitable 5h stop.
test('a window at 99.x% governs a workspace reason just like an exhausted one', () => {
  const c = parseRolloutLine(reached('workspace_owner_usage_limit_reached', 99.6, 40));
  assert.equal(c.limitType, '5h');
  assert.equal(c.resetAt, 1786400000 * 1000);
  assert.equal(c.reachedType, 'workspace_owner_usage_limit_reached');
  // Both spent: the later reset governs, as with exhausted windows.
  assert.equal(parseRolloutLine(reached('workspace_member_credits_depleted', 99.2, 99.4)).limitType, 'weekly');
});

// --- persisted task_complete errors (codex-cli ≥ 0.145) ---
// Verbatim from a ChatGPT desktop app rollout. Behind an OpenAI-compatible
// proxy (model_providers.<x>.base_url) this is the only stop signal: the
// X-Codex-* headers never reach Codex, so every snapshot has null windows.

const STOPPED_AT = '2026-07-23T18:50:34.917Z';
const LIMIT_MESSAGE = "You've hit your usage limit. To get more access now, send a request to your admin or try again at Jul 30th, 2026 10:33 AM.";

function taskCompleteLine(error, at = STOPPED_AT) {
  return JSON.stringify({
    timestamp: at, type: 'event_msg',
    payload: { type: 'task_complete', turn_id: '019f9050-ae37-74b1-944d-1dc075dbc91e',
      last_agent_message: null, error, started_at: 1784832634, completed_at: 1784832634, duration_ms: 492 },
  });
}

test('task_complete usage_limit_exceeded → stop carrying the banner as resetLine', () => {
  const c = parseRolloutLine(taskCompleteLine({ message: LIMIT_MESSAGE, codex_error_info: 'usage_limit_exceeded' }));
  assert.ok(c);
  assert.equal(c.resetAt, null, 'no epoch in the error — the time-parser dates it downstream');
  assert.equal(c.resetLine, LIMIT_MESSAGE);
  assert.equal(c.limitType, 'unknown');
  assert.equal(c.reachedType, null);
  assert.equal(c.timestampMs, Date.parse(STOPPED_AT));
});

test('the banner qualifies with or without the marker', () => {
  const textOnly = parseRolloutLine(taskCompleteLine({ message: "You've hit your usage limit. Try again at 3:51 PM." }));
  assert.equal(textOnly?.resetLine, "You've hit your usage limit. Try again at 3:51 PM.");
  const later = parseRolloutLine(taskCompleteLine({ message: "You’ve hit your usage limit. Try again later.",
    codex_error_info: 'usage_limit_exceeded' }));
  assert.equal(later?.resetLine, "You’ve hit your usage limit. Try again later.", 'unparseable → probe fallback downstream');
  assert.equal(later.limitType, 'unknown');
});

// codex-rs sends codex_error_info "usage_limit_exceeded" for more than usage
// limits (protocol/src/error.rs, to_codex_protocol_error): QuotaExceeded and
// UsageNotIncluded share it. Neither is lifted by waiting, and neither says
// "You've hit your usage limit" — the marker alone is not a stop.
test('the usage_limit_exceeded marker without a banner is not a stop', () => {
  for (const message of [
    'Quota exceeded. Check your plan and billing details.',
    'To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.',
  ]) {
    assert.equal(parseRolloutLine(taskCompleteLine({ message, codex_error_info: 'usage_limit_exceeded' })), null, message);
  }
  // The workspace walls do carry an anchor, spelled the way codex-rs words them.
  for (const message of [
    'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.',
    'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.',
  ]) {
    assert.ok(parseRolloutLine(taskCompleteLine({ message, codex_error_info: 'usage_limit_exceeded' })), message);
  }
});

test('other task_complete outcomes are not stops', () => {
  const bare429 = { message: 'exceeded retry limit, last status: 429 Too Many Requests',
    codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } } };
  assert.equal(parseRolloutLine(taskCompleteLine(bare429)), null,
    'a bare 429 has no reset time — the pane path files it under overload for the same reason');
  assert.equal(parseRolloutLine(taskCompleteLine({ message: 'stream disconnected before completion' })), null);
  assert.equal(parseRolloutLine(taskCompleteLine({ message: 'Server is temporarily limiting requests (not your usage limit)' })), null);
  assert.equal(parseRolloutLine(taskCompleteLine(null)), null);
  assert.equal(parseRolloutLine(JSON.stringify({ timestamp: TS, type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: 'done' } })), null);
});

test('the same turn\'s exhausted snapshot lends its exact epoch to the error', () => {
  const snapshot = tokenCountLine(rateLimits({ primary: { used_percent: 100, window_minutes: 300, resets_at: RESETS_PRIMARY } }));
  const soon = taskCompleteLine({ message: LIMIT_MESSAGE, codex_error_info: 'usage_limit_exceeded' }, '2026-05-13T06:37:11.000Z');
  const hits = parseRolloutLines([snapshot, soon]);
  assert.equal(hits.length, 2);
  assert.equal(hits[1].resetAt, RESETS_PRIMARY * 1000, 'epoch beats the banner\'s minute precision');
  assert.equal(hits[1].limitType, '5h');
  assert.equal(hits[1].resetLine, LIMIT_MESSAGE);
  // An hour later the snapshot is stale: it must not date an unrelated stop.
  const late = taskCompleteLine({ message: LIMIT_MESSAGE, codex_error_info: 'usage_limit_exceeded' }, '2026-05-13T07:37:11.000Z');
  assert.equal(parseRolloutLines([snapshot, late])[1].resetAt, null);
});

test('behind a proxy every snapshot has null windows and only the error dates the stop', () => {
  const proxied = tokenCountLine({ limit_id: 'codex', limit_name: null, primary: null, secondary: null,
    credits: null, individual_limit: null, spend_control_reached: null, plan_type: null, rate_limit_reached_type: null });
  assert.equal(parseRolloutLine(proxied), null);
  const hits = parseRolloutLines([proxied, taskCompleteLine({ message: LIMIT_MESSAGE, codex_error_info: 'usage_limit_exceeded' })]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].resetAt, null);
  assert.equal(hits[0].resetLine, LIMIT_MESSAGE);
});

test('rolloutMeta on a reverted-thread filename falls back to the thread id, not the rollout id', () => {
  const thread = '01a0bcf8-f716-7ac3-b90b-5a2cede549a1';
  const path = join(DIR, `rollout-2026-09-20T14-49-02-${thread}_01a0c026-7b2f-74c3-b576-76743e1da8d7.jsonl`);
  writeFileSync(path, 'garbage not json\n');
  assert.equal(rolloutMeta(path).sessionId, thread);
});

// Review of #28 (Copilot): the pairing must describe a stop that still stands
// when the error is written, not merely the last exhausted snapshot seen.
function tokenCountAt(rl, at) {
  return JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rl } });
}
const EXHAUSTED = rateLimits({ primary: { used_percent: 100, window_minutes: 300, resets_at: RESETS_PRIMARY } });
const LIMIT_ERROR = { message: LIMIT_MESSAGE, codex_error_info: 'usage_limit_exceeded' };

test('a healthy reading of the same bucket in between ends the pairing', () => {
  const hits = parseRolloutLines([
    tokenCountAt(EXHAUSTED, '2026-05-13T06:37:10.000Z'),
    tokenCountAt(rateLimits(), '2026-05-13T06:38:00.000Z'),
    taskCompleteLine(LIMIT_ERROR, '2026-05-13T06:39:00.000Z'),
  ]);
  assert.equal(hits.length, 2);
  assert.equal(hits[1].resetAt, null, 'dated by its own banner, not the cleared snapshot');
  assert.equal(hits[1].resetLine, LIMIT_MESSAGE);
});

test('another bucket\'s healthy line from the same response does not end it', () => {
  // Codex writes one token_count per rate-limit bucket per response.
  const hits = parseRolloutLines([
    tokenCountAt(EXHAUSTED, '2026-05-13T06:37:10.000Z'),
    tokenCountAt(rateLimits({ limit_id: 'codex_other' }), '2026-05-13T06:37:10.600Z'),
    taskCompleteLine(LIMIT_ERROR, '2026-05-13T06:37:11.000Z'),
  ]);
  assert.equal(hits.at(-1).resetAt, RESETS_PRIMARY * 1000);
  assert.equal(hits.at(-1).limitType, '5h');
});

test('an epoch that had already passed when the error was written is not its reset', () => {
  const at = Date.parse('2026-05-13T06:37:10.000Z');
  const soon = Math.floor(at / 1000) + 60;   // the window reset a minute after the snapshot
  const hits = parseRolloutLines([
    tokenCountAt(rateLimits({ primary: { used_percent: 100, window_minutes: 300, resets_at: soon } }),
      new Date(at).toISOString()),
    taskCompleteLine(LIMIT_ERROR, new Date(at + 3 * 60_000).toISOString()),
  ]);
  assert.equal(hits.at(-1).resetAt, null);
});

test('a limit message that wraps onto a second line is read whole', () => {
  const c = parseRolloutLine(taskCompleteLine({ message: "You've hit your usage limit.\nTry again at 3:51 PM." }));
  assert.ok(c, 'the banner anchor is on the first line');
  assert.equal(c.resetLine, 'Try again at 3:51 PM.');
});

// A workspace wall (credits depleted, no window exhausted) is filed as a model
// limit: no reset to wait for. The same turn's task_complete error must not
// turn it back into a stop scheduled from the banner.
// Behind a proxy there is no snapshot to say it is a wall; the banner does.
test('a workspace-wall banner with no snapshot is filed as a wall', () => {
  for (const message of [
    'Your workspace is out of credits. Add credits to continue.',
    'You hit your spend cap set in your workspace. Increase your spend cap to continue.',
  ]) {
    const c = parseRolloutLine(taskCompleteLine({ message, codex_error_info: 'usage_limit_exceeded' }));
    assert.equal(c.limitType, 'model', message);
    assert.equal(c.resetLine, null, 'nothing to schedule — probe, then hold');
  }
  // An ordinary usage limit is still dated from its banner.
  const plain = parseRolloutLine(taskCompleteLine({ message: LIMIT_MESSAGE, codex_error_info: 'usage_limit_exceeded' }));
  assert.equal(plain.limitType, 'unknown');
  assert.equal(plain.resetLine, LIMIT_MESSAGE);
});

test('a limit error in the same turn as a workspace wall stays a wall', () => {
  const wall = tokenCountAt(rateLimits({
    plan_type: 'business', rate_limit_reached_type: 'workspace_member_credits_depleted',
    primary: { used_percent: 97, window_minutes: 300, resets_at: RESETS_PRIMARY },
  }), '2026-05-13T06:37:10.000Z');
  const error = taskCompleteLine({ message: 'Your workspace is out of credits. Ask your workspace owner to add more.',
    codex_error_info: 'usage_limit_exceeded' }, '2026-05-13T06:37:10.500Z');
  const last = parseRolloutLines([wall, error]).at(-1);
  assert.equal(last.limitType, 'model');
  assert.equal(last.resetAt, null);
  assert.equal(last.resetLine, null, 'nothing to schedule — probe, then hold for a human');
  assert.equal(last.reachedType, 'workspace_member_credits_depleted');
});

test('rolloutMeta resolves a multi-agent sub-agent rollout to its parent thread (#50)', () => {
  const parent = '01a12f81-52a5-78f1-99cc-a7a8d58d18e5';
  const child = '01a1438c-8e5f-7871-b785-aaa3362fffc9';
  const path = join(DIR, `rollout-2026-10-16T09-10-47-${child}.jsonl`);
  writeFileSync(path, JSON.stringify({ timestamp: TS, type: 'session_meta', payload: {
    id: child, session_id: parent, parent_thread_id: parent, originator: 'codex-tui', cwd: '/tmp/proj-sub',
  } }) + '\n');
  const info = rolloutMeta(path);
  assert.equal(info.sessionId, parent);
  assert.equal(info.cwd, '/tmp/proj-sub');
});
