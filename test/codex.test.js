// Codex CLI adapter: banner detection fixtures use the exact strings from
// codex-rs/protocol/src/error.rs (see plan/research), so a Codex TUI update
// that changes them should fail here, loudly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import codex from '../src/agents/codex.js';
import { getAgent } from '../src/agents/index.js';
import { detectLimit, isBusy, overloadMatch } from '../src/patterns.js';
import { parseResetTime, resetAtMs } from '../src/time-parser.js';

const MARGIN = 60_000;

test('codex is registered', () => {
  assert.equal(getAgent('codex').id, 'codex');
});

// --- banner variants (verbatim per plan) ---

const VARIANTS = [
  "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:51 PM.",
  "■ You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 9:01 PM.",
  "■ You've hit your usage limit. To get more access now, send a request to your admin or try again at Apr 7th, 2026 1:07 AM.",
  "■ You've hit your usage limit. Try again later.",
  "■ You've hit your usage limit for gpt-5-codex. Switch to another model now, or try again at 4:10 PM.",
  "You've hit your usage limit. Try again in 4 days 20 hours 9 minutes.",
];

for (const banner of VARIANTS) {
  test(`detects limit: "${banner.slice(0, 60)}…"`, () => {
    const pane = `⏺ working on it\n\n${banner}\n\n› Ask Codex to do anything\n`;
    const d = detectLimit(pane, 12, codex.patterns);
    assert.equal(d.hit, true);
    assert.ok(d.resetLine, 'resetLine should be captured');
  });
}

test('workspace credit variants detected', () => {
  const d = detectLimit('■ Your workspace is out of credits. Add credits to continue.\n› \n', 12, codex.patterns);
  assert.equal(d.hit, true);
});

test('transient stream errors are NOT usage limits but ARE overloads', () => {
  const pane = '⚠ stream error: exceeded retry limit, last status: 429 Too Many Requests; retrying 4/5 in 1.471s\n';
  assert.equal(detectLimit(pane, 12, codex.patterns).hit, false);
  assert.ok(overloadMatch(pane, codex.patterns.overloadPatterns));
});

test('busy and idle markers', () => {
  assert.equal(isBusy('• Working (12s • esc to interrupt)\n', codex.patterns.busyPatterns), true);
  const idle = '› Ask Codex to do anything\n\ngpt-5.6 default · /tmp/project\n';
  assert.equal(isBusy(idle, codex.patterns.busyPatterns), false);
  assert.equal(codex.patterns.idleRegex.test(idle), true);
});

// --- resume invocation ---

test('codex resume args carry the message in argv', () => {
  const withId = codex.resumeArgs('0199a213-81c0-7800-8aa1-bbab2a035a53', 'continue');
  assert.deepEqual(withId.args, ['resume', '0199a213-81c0-7800-8aa1-bbab2a035a53', 'continue']);
  assert.equal(withId.messageViaPane, false);
  const noId = codex.resumeArgs(null, 'continue');
  assert.deepEqual(noId.args, ['resume', '--last', 'continue']);
});

// #25: the TUI exits 1 ("stdin is not a terminal") under the headless backend,
// which then read the empty capture as a clean resume. Headless takes the
// non-interactive subcommand; a real pane keeps the TUI form untouched.
test('codex resumes headless through `exec resume`, never the TUI', () => {
  const id = '0199a213-81c0-7800-8aa1-bbab2a035a53';
  assert.deepEqual(codex.resumeArgs(id, 'continue', { canType: false }).args,
    ['exec', '--skip-git-repo-check', 'resume', id, 'continue']);
  assert.deepEqual(codex.resumeArgs(null, 'continue', { canType: false }).args,
    ['exec', '--skip-git-repo-check', 'resume', '--last', 'continue']);
  assert.deepEqual(codex.resumeArgs(id, 'continue', { canType: true }).args,
    ['resume', id, 'continue']);
  assert.equal(codex.resumeArgs(id, 'continue', { canType: false }).messageViaPane, false);
  // `exec` exits 1 outside a git repository ("Not inside a trusted directory
  // and --skip-git-repo-check was not specified") — the TUI form never did.
  assert.ok(codex.resumeArgs(id, 'continue', { canType: false }).args.includes('--skip-git-repo-check'));
  assert.ok(!codex.resumeArgs(id, 'continue', { canType: true }).args.includes('--skip-git-repo-check'));
});

test('codex foreground command check', () => {
  assert.equal(codex.isForegroundCommand('codex'), true);
  assert.equal(codex.isForegroundCommand('zsh'), false);
});

// --- time-parser extensions for codex formats ---

test('parses "or try again at 3:51 PM."', () => {
  const p = parseResetTime('■ You\'ve hit your usage limit. … or try again at 3:51 PM.');
  assert.equal(p.hour, 15);
  assert.equal(p.minute, 51);
});

test('parses cross-day "try again at Feb 23rd, 2026 9:01 PM."', () => {
  const p = parseResetTime('or try again at Feb 23rd, 2026 9:01 PM.');
  assert.equal(p.absolute, true);
  const expected = new Date(2026, 1, 23, 21, 1).getTime();
  assert.equal(p.atMs, expected);
  const { at, source } = resetAtMs(p, { marginMs: MARGIN, now: new Date(2026, 1, 20) });
  assert.equal(source, 'absolute');
  assert.equal(at, expected + MARGIN);
});

test('parses multi-unit "Try again in 4 days 20 hours 9 minutes."', () => {
  const p = parseResetTime('Try again in 4 days 20 hours 9 minutes.');
  assert.equal(p.relative, true);
  assert.equal(p.waitMs, ((4 * 24 + 20) * 60 + 9) * 60_000);
});

test('"Try again later." yields no parse (fallback path)', () => {
  assert.equal(parseResetTime("You've hit your usage limit. Try again later."), null);
});

// --- unified ChatGPT desktop app (2026): codex binary ships inside the app ---

test('codex bin resolution falls back to the ChatGPT app bundle', async () => {
  const { resolveCodexBin, CHATGPT_CODEX_BIN } = await import('../src/agents/codex.js');
  // The bundle is a macOS thing; pin the platform so the Windows runner does
  // not take its own branch here.
  const mac = opts => resolveCodexBin({ platform: 'darwin', ...opts });
  // env override always wins
  assert.equal(mac({ env: { UNSNOOZE_CODEX_BIN: '/x/codex' }, onPath: () => true, exists: () => true }), '/x/codex');
  // codex on PATH → plain name (standalone CLI installs)
  assert.equal(mac({ env: {}, onPath: () => true, exists: () => false }), 'codex');
  // not on PATH but the unified ChatGPT app is installed → bundled binary
  assert.equal(mac({ env: {}, onPath: () => false, exists: p => p === CHATGPT_CODEX_BIN }), CHATGPT_CODEX_BIN);
  // neither → plain name so the launcher can degrade gracefully
  assert.equal(mac({ env: {}, onPath: () => false, exists: () => false }), 'codex');
  // Explicitly non-win32: the platform decides the search, not the host.
  assert.equal(resolveCodexBin({ env: { PATH: '/opt/bin:/usr/bin' }, platform: 'linux', exists: p => p === '/usr/bin/codex' }), 'codex');
});

// --- Windows (#25): PATH is ';'-separated, the CLI is codex.exe, and the
// Desktop/Store install keeps it under a versioned runtime directory that a
// daemon's logon-time PATH stops describing after the first update. ---

test('windows codex resolution: exe on PATH, then the newest bundled runtime, then a shim by full path', async () => {
  const { resolveCodexBin } = await import('../src/agents/codex.js');
  const win = (files, extra = {}) => resolveCodexBin({
    platform: 'win32',
    env: { PATH: 'C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\old-hash;C:\\Program Files\\nodejs;C:\\Users\\me\\AppData\\Roaming\\npm', ...extra },
    exists: p => files.includes(p),
    bundled: () => extra.runtime ?? null,
  });
  // A ':' split of that PATH finds nothing; a ';' split finds the exe → bare name (spawn resolves .exe itself).
  assert.equal(win(['C:\\Program Files\\nodejs\\codex.exe'], { runtime: 'C:\\x\\codex.exe' }), 'codex',
    'a live exe on PATH must be found before the bundled runtime is consulted');
  // The PATH entry is a dead runtime dir → the newest live runtime, by full path.
  assert.equal(win([], { runtime: 'C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\new-hash\\codex.exe' }),
    'C:\\Users\\me\\AppData\\Local\\OpenAI\\Codex\\bin\\new-hash\\codex.exe');
  // Only an npm .cmd shim: named in full, so the launcher's refusal says which file.
  assert.equal(win(['C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd']),
    'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd');
  // A live exe on PATH beats the bundled runtime; the env override beats everything.
  assert.equal(win(['C:\\Program Files\\nodejs\\codex.exe'], { runtime: 'C:\\x\\codex.exe' }), 'codex');
  assert.equal(win([], { UNSNOOZE_CODEX_BIN: 'D:\\tools\\codex.exe', runtime: 'C:\\x\\codex.exe' }), 'D:\\tools\\codex.exe');
  assert.equal(win([]), 'codex');
});

test('windowsBundledCodex picks the newest <hash>/codex.exe under the Desktop install', async () => {
  const { windowsBundledCodex } = await import('../src/agents/codex.js');
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const local = mkdtempSync(join(tmpdir(), 'unsnooze-localappdata-'));
  try {
    const bin = join(local, 'OpenAI', 'Codex', 'bin');
    for (const [hash, ageMin] of [['aaaa1111', 60], ['bbbb2222', 5], ['cccc3333', 30]]) {
      mkdirSync(join(bin, hash), { recursive: true });
      writeFileSync(join(bin, hash, 'codex.exe'), '');
      const t = new Date(Date.now() - ageMin * 60_000);
      utimesSync(join(bin, hash, 'codex.exe'), t, t);
    }
    mkdirSync(join(bin, 'empty-runtime'));          // a dir with no exe is skipped
    writeFileSync(join(bin, 'stray-file'), '');       // as is a file at that level
    assert.equal(windowsBundledCodex({ env: { LOCALAPPDATA: local } }), join(bin, 'bbbb2222', 'codex.exe'));
    assert.equal(windowsBundledCodex({ env: { LOCALAPPDATA: join(local, 'nowhere') } }), null);
    assert.equal(windowsBundledCodex({ env: {} }), null);
  } finally {
    rmSync(local, { recursive: true, force: true });
  }
});
