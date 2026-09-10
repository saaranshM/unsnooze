// fish shell support: wrappers into ~/.config/fish/config.fish.
// Fish shares no syntax with the POSIX rc block (`name() { … }` is a parse
// error there, `$?` is `$status`), so install.js carries a separate fish
// block, its own target selection, and uninstall coverage — everything
// asserted here mirrors the zsh/bash cases in install.test.js.

import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Uninstall also removes other shell wrappers, hooks, and the daemon lock.
// Resolve every default path inside this fixture before importing install.js.
const PROFILE = mkdtempSync(join(tmpdir(), 'unsnooze-fish-profile-'));
mock.method(os, 'homedir', () => PROFILE);
syncBuiltinESMExports();
for (const [name, path] of Object.entries({
  UNSNOOZE_STATE_DIR: 'state', UNSNOOZE_CLAUDE_DIR: 'claude',
  UNSNOOZE_GROK_DIR: 'grok', UNSNOOZE_QWEN_DIR: 'qwen',
  UNSNOOZE_FISH_CONFIG: 'config.fish',
  UNSNOOZE_LAUNCH_AGENTS_DIR: 'LaunchAgents', UNSNOOZE_SYSTEMD_USER_DIR: 'systemd',
})) process.env[name] = join(PROFILE, path);

const {
  cmdInstall, cmdUninstall, installFishBlock, fishWrapperBlock, stripFencedBlock,
} = await import('../src/install.js');
import { fishConfigPath } from '../src/fish.js';

after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// Native Windows install/uninstall also changes PowerShell and Task Scheduler.
// Keep the fish integration cases on platforms that actually run fish.
const installTest = (name, fn) => test(name, { skip: process.platform === 'win32' }, fn);

test('fishConfigPath honors XDG_CONFIG_HOME (absolute only) and UNSNOOZE_FISH_CONFIG', () => {
  assert.equal(
    fishConfigPath({ env: { XDG_CONFIG_HOME: '/x/cfg' }, home: '/home/me' }),
    join('/x/cfg', 'fish', 'config.fish'));
  // A relative XDG value must be ignored per the XDG spec.
  assert.equal(
    fishConfigPath({ env: { XDG_CONFIG_HOME: 'rel/path' }, home: '/home/me' }),
    join('/home/me', '.config', 'fish', 'config.fish'));
  assert.equal(
    fishConfigPath({ env: { UNSNOOZE_FISH_CONFIG: '/override/cfg.fish' }, home: '/home/me' }),
    '/override/cfg.fish');
  assert.equal(
    fishConfigPath({ env: {}, home: '/home/me' }),
    join('/home/me', '.config', 'fish', 'config.fish'));
});

test('fish wrapper block contains one function per enabled agent, routed via _run', () => {
  const content = installFishBlock('', ['claude', 'codex']);
  assert.match(content, /function claude /);
  assert.match(content, /function codex /);
  assert.ok(!content.includes('function grok '), 'disabled agents get no wrapper');
  assert.match(content, /_run claude \$argv/);
  assert.match(content, /_run codex \$argv/);
  assert.match(content, /UNSNOOZE_ACTIVE/);
  // fish exit-status plumbing, not POSIX `$?`.
  assert.match(content, /return \$status/);
  assert.ok(!content.includes('$?'), 'POSIX $? has no meaning in fish');
  assert.equal(content.split('# >>> unsnooze >>>').length, 2);
});

test('cursor wraps cursor-agent, never the bare cursor command', () => {
  const content = installFishBlock('', ['cursor']);
  assert.match(content, /function cursor-agent /);
  assert.ok(!content.includes('function cursor '), 'the IDE launcher must never be shadowed');
  assert.match(content, /_run cursor \$argv/, 'the _run argument stays the agent id');
});

test('fish wrapper falls back to the real CLI when the unsnooze entry point is gone', () => {
  // Same load-bearing guard as the POSIX wrapper: a vanished bin must degrade
  // to the plain CLI, never brick the command.
  const content = installFishBlock('', ['claude']);
  const guard = content.match(/not test -f '([^']+)'/);
  assert.ok(guard, 'wrapper must check the entry point exists before exec-ing it');
  assert.match(guard[1], /unsnooze\.js$/);
});

test('installFishBlock is replace-don-append, like the POSIX twin', () => {
  const first = { content: installFishBlock('# my fish config\n', ['claude', 'grok']) };
  assert.equal(first.content.split('# >>> unsnooze >>>').length, 2);
  assert.ok(first.content.startsWith('# my fish config'));
  const second = { content: installFishBlock(first.content, ['claude']) };
  assert.equal(second.content.split('# >>> unsnooze >>>').length, 2, 're-run must never stack a second block');
  assert.ok(!second.content.includes('function grok '), 'replaced block reflects the new agent set');
  assert.ok(second.content.includes('# my fish config'));
});

test('generated block parses as real fish', t => {
  let fish = null;
  try { fish = execFileSync('which', ['fish'], { encoding: 'utf-8' }).trim(); } catch { /* absent */ }
  if (!fish) return t.skip('fish is not installed');
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-fish-parse-'));
  try {
    const content = installFishBlock('', ['claude', 'codex', 'grok', 'qwen', 'kimi', 'opencode', 'agy', 'cursor']);
    const f = join(dir, 'config.fish');
    writeFileSync(f, content);
    execFileSync(fish, ['-n', f], { stdio: ['ignore', 'ignore', 'pipe'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the fish block round-trips through stripFencedBlock for uninstall', () => {
  const installed = installFishBlock('set -x EDITOR nvim\n', ['claude']);
  const { content, found } = stripFencedBlock(installed, '# >>> unsnooze >>>', '# <<< unsnooze <<<');
  assert.equal(found, true);
  assert.ok(!content.includes('_run'));
  assert.match(content, /set -x EDITOR nvim/);
});

installTest('cmdInstall writes the fish config at --fishrc, backing up first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-fish-install-'));
  try {
    const settings = join(dir, 'settings.json');
    const rc = join(dir, 'zshrc');
    const fishrc = join(dir, 'config.fish');
    writeFileSync(fishrc, '# my fish config\n');
    const code = cmdInstall(['--yes', '--settings', settings, '--zshrc', rc, '--fishrc', fishrc], { agents: ['claude'] });
    assert.equal(code, 0);
    const out = readFileSync(fishrc, 'utf-8');
    assert.match(out, /# >>> unsnooze >>>/);
    assert.match(out, /function claude /);
    assert.match(readFileSync(`${fishrc}.unsnooze-orig`, 'utf-8'), /my fish config/,
      'first run snapshots the pre-unsnooze fish config');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

installTest('cmdInstall creates config.fish when fish is the login shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-fish-login-'));
  const prevFish = process.env.UNSNOOZE_FISH_CONFIG;
  const prevShell = process.env.SHELL;
  try {
    // Point the fish target into the tmp dir, then pretend fish is the login
    // shell with no config.fish yet — a fish user's first-run case.
    process.env.UNSNOOZE_FISH_CONFIG = join(dir, 'config.fish');
    process.env.SHELL = '/usr/bin/fish';
    const settings = join(dir, 'settings.json');
    const rc = join(dir, 'zshrc');
    assert.ok(!existsSync(join(dir, 'config.fish')));
    const code = cmdInstall(['--yes', '--settings', settings, '--zshrc', rc], { agents: ['claude'] });
    assert.equal(code, 0);
    assert.match(readFileSync(join(dir, 'config.fish'), 'utf-8'), /function claude /);
  } finally {
    if (prevFish === undefined) delete process.env.UNSNOOZE_FISH_CONFIG; else process.env.UNSNOOZE_FISH_CONFIG = prevFish;
    if (prevShell === undefined) delete process.env.SHELL; else process.env.SHELL = prevShell;
    rmSync(dir, { recursive: true, force: true });
  }
});

installTest('cmdInstall leaves fish alone when there is no fish on the machine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-fish-absent-'));
  const prevFish = process.env.UNSNOOZE_FISH_CONFIG;
  const prevShell = process.env.SHELL;
  try {
    process.env.UNSNOOZE_FISH_CONFIG = join(dir, 'config.fish');
    process.env.SHELL = '/bin/bash';
    const settings = join(dir, 'settings.json');
    const rc = join(dir, 'zshrc');
    const code = cmdInstall(['--yes', '--settings', settings, '--zshrc', rc], { agents: ['claude'] });
    assert.equal(code, 0);
    assert.ok(!existsSync(join(dir, 'config.fish')), 'no fish evidence, no fish config');
  } finally {
    if (prevFish === undefined) delete process.env.UNSNOOZE_FISH_CONFIG; else process.env.UNSNOOZE_FISH_CONFIG = prevFish;
    if (prevShell === undefined) delete process.env.SHELL; else process.env.SHELL = prevShell;
    rmSync(dir, { recursive: true, force: true });
  }
});

installTest('cmdUninstall removes the fish block and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-fish-uninstall-'));
  try {
    const settings = join(dir, 'settings.json');
    const fishrc = join(dir, 'config.fish');
    writeFileSync(fishrc, '# keep me\n');
    cmdInstall(['--yes', '--settings', settings, '--fishrc', fishrc], { agents: ['claude'] });
    const code = cmdUninstall(['--fishrc', fishrc]);
    assert.equal(code, 0);
    const after = readFileSync(fishrc, 'utf-8');
    assert.ok(!after.includes('# >>> unsnooze >>>'));
    assert.ok(!after.includes('function claude'));
    assert.match(after, /# keep me/, 'user content is preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

installTest('cmdUninstall removes fish block created by login-shell install', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-fish-uninstall2-'));
  const prevFish = process.env.UNSNOOZE_FISH_CONFIG;
  const prevShell = process.env.SHELL;
  try {
    process.env.UNSNOOZE_FISH_CONFIG = join(dir, 'config.fish');
    process.env.SHELL = '/usr/bin/fish';
    const settings = join(dir, 'settings.json');
    cmdInstall(['--yes', '--settings', settings], { agents: ['claude'] });
    assert.ok(readFileSync(join(dir, 'config.fish'), 'utf-8').includes('# >>> unsnooze >>>'));
    cmdUninstall([]);
    assert.ok(!readFileSync(join(dir, 'config.fish'), 'utf-8').includes('# >>> unsnooze >>>'));
  } finally {
    if (prevFish === undefined) delete process.env.UNSNOOZE_FISH_CONFIG; else process.env.UNSNOOZE_FISH_CONFIG = prevFish;
    if (prevShell === undefined) delete process.env.SHELL; else process.env.SHELL = prevShell;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fish wrapper actually routes, guards, and propagates exit status', t => {
  let fish = null;
  try { fish = execFileSync('which', ['fish'], { encoding: 'utf-8' }).trim(); } catch { /* absent */ }
  if (!fish) return t.skip('fish is not installed');
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-fish-live-'));
  try {
    const fakeBin = join(dir, 'unsnooze.js');
    writeFileSync(fakeBin, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));process.exit(7);\n');
    const block = fishWrapperBlock(['claude'], fakeBin);
    const cfg = join(dir, 'config.fish');
    writeFileSync(cfg, block);

    // Routes through unsnooze with argv intact.
    const routed = execFileSync(fish, ['--no-config', '-c', `source '${cfg}'; claude hello "two words"; echo "exit=$status"`],
      { encoding: 'utf-8', env: { ...process.env, UNSNOOZE_ACTIVE: '' } });
    assert.match(routed, /"_run"/);
    assert.match(routed, /"claude"/, 'the _run argument stays the agent id');
    assert.match(routed, /"two words"/, 'argv quoting must survive fish expansion');
    assert.match(routed, /exit=7/, 'exit status must propagate');

    // Recursion guard: an active unsnooze run falls back to the real CLI.
    const guarded = execFileSync(fish, ['--no-config', '-c', `set -gx UNSNOOZE_ACTIVE 1; source '${cfg}'; type -q claude; and echo shadowed`],
      { encoding: 'utf-8' });
    assert.match(guarded, /shadowed/, 'the wrapper function must still be defined under the guard');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
