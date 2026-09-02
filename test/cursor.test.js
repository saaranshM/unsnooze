// Cursor CLI (cursor-agent) adapter. The limit banner is SERVER-provided — the
// shipped bundle contains no limit strings, only the renderer that prints
// `Error: ${details.title}`, then `details.detail`, then one `key: value` line
// per `details.additionalInfo` entry. USAGE_LIMIT below is a VERBATIM capture
// of a real limit (free plan, cursor-agent 2026.08.31-4057e58, 2026-09-02);
// the Pro-plan wording is from user reports; the auth and network strings are
// verbatim from the bundle. A Cursor change to any of them should fail here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-cursor-test-'));
after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

// Reproduces the real layout: ~/.cursor/chats/<md5(cwd)>/<chatId>/meta.json,
// where <chatId> is the directory name and is what `--resume=<id>` takes.
function seedChat(cwd, chatId, updatedAtMs, { hash = null } = {}) {
  const project = hash ?? createHash('md5').update(cwd).digest('hex');
  const dir = join(DIR, 'chats', project, chatId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({
    schemaVersion: 1, hasConversation: true, title: 'seeded', cwd, updatedAtMs,
  }));
  return dir;
}

const { default: cursor, latestSessionId } = await import('../src/agents/cursor.js');
const { getAgent } = await import('../src/agents/index.js');
const { detectLimit, overloadMatch, isBusy } = await import('../src/patterns.js');
const { wrapperBlock, wrapperNamesFor } = await import('../src/install.js');

// Captured verbatim from a real usage limit on a free plan.
const USAGE_LIMIT = [
  "  Error: You've hit your usage limit",
  '  Get Cursor Pro for more Agent usage, unlimited Tab, and more.',
  '  fallbackModel:',
  '  spendLimitHit: false',
  "  chatMessage: *You've hit your free requests limit. [Upgrade to",
  '  Pro](https://www.cursor.com/api/auth/checkoutDeepControl?tier=pro) for more usage, frontier models, Cloud Agents,',
  '  and more. Your usage limits will reset when your monthly cycle ends on 10/2/2026.*',
  '  spendLimits: [50,100,200]',
].join('\n');

// The Pro-plan render carries different remedy wording (user-reported).
const USAGE_LIMIT_PRO = [
  "Error: You've hit your usage limit",
  "You've saved $18.42 on API model usage this month with Pro. Switch to Auto for more usage or set a Spend Limit to continue with Sonnet.",
  'fallbackModel: default',
  'spendLimitHit: false',
].join('\n');

test('cursor is registered and experimental', () => {
  assert.equal(getAgent('cursor').id, 'cursor');
  assert.equal(cursor.experimental, true);
});

// --- the limit banner takes the model path, never a scheduled wait ---

test('the usage-limit banner is detected as a model limit with no reset time', () => {
  const pane = `→ refactor the auth module\n\n${USAGE_LIMIT}\n\n→ \n`;
  const d = detectLimit(pane, 12, cursor.patterns);
  assert.equal(d.hit, true);
  assert.equal(d.limitType, 'model');
  assert.equal(d.resetLine, null);
});

test('the curly-apostrophe render is detected too', () => {
  const pane = `Error: You’ve hit your usage limit\nSwitch to Auto for more usage or set a Spend Limit.\n\n→ \n`;
  const d = detectLimit(pane, 12, cursor.patterns);
  assert.equal(d.hit, true);
  assert.equal(d.limitType, 'model');
});

// This is the invariant the whole design rests on. Cursor's usage resets on the
// monthly BILLING CYCLE, so a waitable record would schedule a blind resume
// into a wall that is still standing. resetPatterns is empty on purpose;
// adding one here silently re-routes every limit onto the 5h fallback ladder.
test('cursor never produces a waitable limit — resetPatterns stays empty', () => {
  assert.deepEqual(cursor.patterns.resetPatterns, []);
  assert.deepEqual(cursor.patterns.weeklyPatterns, []);
  assert.deepEqual(cursor.patterns.fiveHourPatterns, []);
  // The real banner already contains "…reset when your monthly cycle ends on
  // 10/2/2026" — a month out. It must still come back as a model limit.
  const d = detectLimit(`${USAGE_LIMIT}\n\n → \n`, 12, cursor.patterns);
  assert.equal(d.hit, true);
  assert.equal(d.limitType, 'model', 'a billing date must not make this a waitable stop');
  assert.equal(d.resetLine, null);
});

test('the Pro-plan wording is detected as well as the free-plan one', () => {
  const d = detectLimit(`${USAGE_LIMIT_PRO}\n\n → \n`, 12, cursor.patterns);
  assert.equal(d.hit, true);
  assert.equal(d.limitType, 'model');
});

// Detection must not hinge on the additionalInfo keys alone — Cursor could drop
// them without changing what the user sees. The detail line has to carry it.
test('the banner is still detected without its additionalInfo lines', () => {
  const minimal = [
    "  Error: You've hit your usage limit",
    '  Get Cursor Pro for more Agent usage, unlimited Tab, and more.',
    '',
    ' → ',
  ].join('\n');
  assert.equal(detectLimit(minimal, 12, cursor.patterns).hit, true);
});

// `-p` prints the error CLASS name instead of the TUI's `Error:` prefix.
test('the headless render is detected too', () => {
  const headless = "ActionRequiredError: You've hit your usage limit Get Cursor Pro for more Agent usage, unlimited Tab, and more.\n";
  const d = detectLimit(headless, 12, cursor.patterns);
  assert.equal(d.hit, true);
  assert.equal(d.limitType, 'model');
});

// --- negative classes ---

test('transport errors are overload, not a limit', () => {
  const pane = "Error: Can't reach the Cursor API — network unreachable (ENETUNREACH). Check your network/VPN/DNS.\n→ \n";
  assert.equal(detectLimit(pane, 12, cursor.patterns).hit, false);
  assert.ok(overloadMatch(pane, cursor.patterns.overloadPatterns));
});

test('a dropped stream is overload, not a limit', () => {
  const pane = 'Error: socket hang up (ECONNRESET)\nAgent stopped retrying\n→ \n';
  assert.equal(detectLimit(pane, 12, cursor.patterns).hit, false);
  assert.ok(overloadMatch(pane, cursor.patterns.overloadPatterns));
});

test('an expired login is a terminal error — notify only, never a ledger record', () => {
  const pane = "Error: Authentication required. Please run 'cursor-agent login' first, or set CURSOR_API_KEY environment variable.\n";
  assert.equal(detectLimit(pane, 12, cursor.patterns).hit, false);
  assert.ok(overloadMatch(pane, cursor.patterns.terminalPatterns));
  assert.equal(overloadMatch(pane, cursor.patterns.overloadPatterns), null);
});

test('the same message from the `agent` alias also matches', () => {
  const pane = "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n";
  assert.ok(overloadMatch(pane, cursor.patterns.terminalPatterns));
});

test('agent prose about usage limits is not a limit stop', () => {
  const pane = [
    '→ explain the billing code',
    '',
    '  The handler should surface a clear message when a user has hit their',
    '  usage limit, and suggest they `Switch to Auto for more usage`.',
    '',
    '→ ',
  ].join('\n');
  assert.equal(detectLimit(pane, 12, cursor.patterns).hit, false);
});

test('a hypothetical limit is not a limit stop', () => {
  const pane = '  A long run could hit your usage limit — set a Spend Limit first.\n\n→ \n';
  assert.equal(detectLimit(pane, 12, cursor.patterns).hit, false);
});

// --- busy / idle ---

// Captured verbatim from a live 2026.08.31-4057e58 session in tmux.
test('the generating render reads as busy; the bare prompt reads as idle', () => {
  const working = [
    '⠘⠤ Working',
    '   Tip: Use /config to customize Cursor settings and behavior.',
    ' → Add a follow-up                                             ctrl+c to stop',
  ].join('\n');
  assert.equal(isBusy(working, cursor.patterns.busyPatterns), true);

  const idle = ' → Plan, search, build anything\n Auto · 9.1%\n';
  assert.equal(isBusy(idle, cursor.patterns.busyPatterns), false);
  assert.ok(cursor.patterns.idleRegex.test(idle));
});

test('the spinner label only counts with its braille frame, not in prose', () => {
  assert.equal(isBusy('  I am Working on the parser now.\n → \n', cursor.patterns.busyPatterns), false);
  assert.equal(isBusy('⠀⠞ Working\n', cursor.patterns.busyPatterns), true);
});

// A first launch in an untrusted directory shows a modal gate instead of the
// prompt. It must never be typed into: it carries no `→` (so idleRegex already
// refuses) and busyPatterns names it too, so the refusal is not incidental.
test('the workspace-trust gate is never mistaken for a ready prompt', () => {
  const trust = [
    '  │  ⚠ Workspace Trust Required                        │',
    '  │  Do you trust the contents of this directory?       │',
    '  │  ▶ [a] Trust this workspace                         │',
    '  │    [q] Quit                                         │',
  ].join('\n');
  assert.equal(cursor.patterns.idleRegex.test(trust), false);
  assert.equal(isBusy(trust, cursor.patterns.busyPatterns), true);
  // and unsnooze must not silently grant trust on revival
  assert.equal(cursor.resumeArgs('chat-1', 'go').args.includes('--trust'), false);
  assert.equal(cursor.resumeArgs(null, 'go').args.includes('--trust'), false);
});

// --- resume invocation ---

test('cursor resume args use --resume=<id>, --continue without one', () => {
  const withId = cursor.resumeArgs('chat-abc123', 'continue');
  assert.deepEqual(withId.args, ['--resume=chat-abc123']);
  assert.equal(withId.messageViaPane, true);
  const noId = cursor.resumeArgs(null, 'continue');
  assert.deepEqual(noId.args, ['--continue']);
  assert.equal(noId.messageViaPane, true);
});

test('cursor foreground command check covers the node shim', () => {
  // The bash shim execs the bundled node, so tmux reports `node`.
  assert.equal(cursor.isForegroundCommand('node'), true);
  assert.equal(cursor.isForegroundCommand('cursor-agent'), true);
  assert.equal(cursor.isForegroundCommand('agent'), true);
  assert.equal(cursor.isForegroundCommand('zsh'), false);
  assert.equal(cursor.isForegroundCommand('vim'), false);
});

// --- latestSessionId: md5 fast path, bounded fallback, null on any doubt ---

test('latestSessionId returns the newest chat id for the cwd', () => {
  seedChat('/tmp/proj-cursor', 'chat-old', 1_000);
  seedChat('/tmp/proj-cursor', 'chat-new', 2_000);
  seedChat('/tmp/other-proj', 'chat-elsewhere', 9_000);
  assert.equal(latestSessionId('/tmp/proj-cursor', null, DIR), 'chat-new');
  assert.equal(latestSessionId('/tmp/other-proj', null, DIR), 'chat-elsewhere');
});

test('a chat filed under an unexpected project hash is still found by the fallback scan', () => {
  seedChat('/tmp/rehashed', 'chat-rehashed', 3_000, { hash: 'not-an-md5-of-anything' });
  assert.equal(latestSessionId('/tmp/rehashed', null, DIR), 'chat-rehashed');
});

test('latestSessionId is null for an unknown cwd, a missing dir, or foreign metadata', () => {
  assert.equal(latestSessionId('/nope/never', null, DIR), null);
  assert.equal(latestSessionId('/tmp/proj-cursor', null, join(DIR, 'no-such-dir')), null);
  assert.equal(latestSessionId(null, null, DIR), null);
  // meta.json without a cwd must never be trusted — a wrong id resumes the
  // wrong conversation, so the answer is null, not a guess.
  const bare = join(DIR, 'chats', createHash('md5').update('/tmp/schema-drift').digest('hex'), 'chat-x');
  mkdirSync(bare, { recursive: true });
  writeFileSync(join(bare, 'meta.json'), JSON.stringify({ schemaVersion: 2, title: 'no cwd here' }));
  assert.equal(latestSessionId('/tmp/schema-drift', null, DIR), null);
});

// --- the wrapper must shadow cursor-agent and NEVER the IDE launcher ---

test('the shell wrapper wraps cursor-agent, not the `cursor` IDE command', () => {
  assert.deepEqual(cursor.wrapperNames, ['cursor-agent']);
  assert.deepEqual(wrapperNamesFor('cursor'), ['cursor-agent']);
  const block = wrapperBlock(['cursor']);
  assert.match(block, /^cursor-agent\(\) \{$/m);
  assert.doesNotMatch(block, /^cursor\(\) \{$/m, '`cursor .` opens the IDE — never shadow it');
  // the function is named for the command, but _run still carries the agent id
  assert.match(block, /_run cursor "\$@"/);
});

test('agents without wrapperNames still wrap their own id', () => {
  assert.deepEqual(wrapperNamesFor('claude'), ['claude']);
  assert.deepEqual(wrapperNamesFor('opencode'), ['opencode']);
  // getAgent falls back to claude for unknown ids — never borrow its names
  assert.deepEqual(wrapperNamesFor('nope'), ['nope']);
});

// A model limit has no reset time, so the notification is the whole remedy.
// Telling a Cursor user to run /usage-credits — a command Cursor does not have
// — is worse than saying nothing.
test('the model-limit remedy hint is per-CLI', async () => {
  const { modelRemedy } = await import('../src/patterns.js');
  assert.match(modelRemedy(cursor), /Auto|on-demand/);
  assert.doesNotMatch(modelRemedy(cursor), /usage-credits/);
  assert.match(modelRemedy(getAgent('claude')), /usage-credits/);
  // adapters with no model limits (and no agent at all) still get a sane line
  assert.equal(modelRemedy(getAgent('grok')), 'switch models or add credits');
  assert.equal(modelRemedy(undefined), 'switch models or add credits');
});
