import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cmdInstall, mergeHookIntoSettings, removeHookFromSettings, installZshrcBlock, stripFencedBlock,
} from '../src/install.js';

const REAL_ISH_SETTINGS = JSON.stringify({
  model: 'claude-fable-5[1m]',
  permissions: { defaultMode: 'acceptEdits', allow: ['Bash(ls:*)'] },
  hooks: {
    StopFailure: [{
      matcher: 'overloaded|server_error|rate_limit',
      hooks: [{ type: 'command', command: 'node /x/claude-auto-retry/bin/cli.js _stopfailure-hook', timeout: 5 }],
    }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
  },
  enabledPlugins: ['superpowers'],
}, null, 2);

test('merge replaces claude-auto-retry hook, preserves everything else', () => {
  const out = JSON.parse(mergeHookIntoSettings(REAL_ISH_SETTINGS));
  assert.equal(out.model, 'claude-fable-5[1m]');
  assert.deepEqual(out.enabledPlugins, ['superpowers']);
  assert.equal(out.hooks.SessionStart.length, 1);
  assert.equal(out.hooks.StopFailure.length, 1);
  const cmd = out.hooks.StopFailure[0].hooks[0].command;
  assert.match(cmd, /unsnooze\.js"? _hook-stopfailure/);
  assert.ok(!cmd.includes('claude-auto-retry'));
});

test('merge is idempotent', () => {
  const once = mergeHookIntoSettings(REAL_ISH_SETTINGS);
  const twice = mergeHookIntoSettings(once);
  assert.equal(JSON.parse(twice).hooks.StopFailure.length, 1);
});

test('merge into empty settings works', () => {
  const out = JSON.parse(mergeHookIntoSettings('{}'));
  assert.equal(out.hooks.StopFailure.length, 1);
});

test('removeHookFromSettings removes only ours', () => {
  const merged = mergeHookIntoSettings(REAL_ISH_SETTINGS);
  const removed = JSON.parse(removeHookFromSettings(merged));
  assert.equal(removed.hooks.StopFailure, undefined);
  assert.equal(removed.hooks.SessionStart.length, 1);
});

const OLD_ZSHRC = `export PATH=$PATH:/foo

# >>> claude-auto-retry >>>
unalias claude 2>/dev/null || true
claude() {
  if [ "\${CLAUDE_AUTO_RETRY_ACTIVE}" = "1" ]; then
    command claude "$@"
  fi
}
# <<< claude-auto-retry <<<

alias ll='ls -la'
`;

test('installZshrcBlock removes old block, adds fenced new one', () => {
  const { content, oldRemoved } = installZshrcBlock(OLD_ZSHRC);
  assert.equal(oldRemoved, true);
  assert.ok(!content.includes('CLAUDE_AUTO_RETRY_ACTIVE'));
  assert.ok(content.includes('# >>> unsnooze >>>'));
  assert.ok(content.includes("alias ll='ls -la'"));
  assert.ok(content.includes('export PATH=$PATH:/foo'));
  // Idempotent: installing again yields exactly one block
  const again = installZshrcBlock(content).content;
  assert.equal(again.split('# >>> unsnooze >>>').length, 2);
});

// Migration off the pre-release "claude-session-guard" (csg) install.
const LEGACY_CSG_ZSHRC = `export PATH=$PATH:/foo

# >>> claude-session-guard >>>
unalias claude 2>/dev/null || true
claude() {
  if [ "\${CSG_ACTIVE}" = "1" ]; then
    command claude "$@"
    return $?
  fi
  node "/x/claude-session-guard/bin/csg.js" "$@"
}
# <<< claude-session-guard <<<

alias ll='ls -la'
`;

test('installZshrcBlock removes legacy claude-session-guard block', () => {
  const { content, oldRemoved } = installZshrcBlock(LEGACY_CSG_ZSHRC);
  assert.equal(oldRemoved, true);
  assert.ok(!content.includes('# >>> claude-session-guard >>>'));
  assert.ok(!content.includes('# <<< claude-session-guard <<<'));
  assert.ok(!content.includes('csg.js'));
  assert.ok(!content.includes('CSG_ACTIVE'));
  assert.ok(content.includes('# >>> unsnooze >>>'));
  assert.ok(content.includes("alias ll='ls -la'"));
});

test('merge replaces legacy csg hook entry', () => {
  const legacy = JSON.stringify({
    hooks: {
      StopFailure: [{
        matcher: 'overloaded|server_error|rate_limit',
        hooks: [{ type: 'command', command: 'node /x/claude-session-guard/bin/csg.js _hook-stopfailure', timeout: 5 }],
      }],
    },
  });
  const out = JSON.parse(mergeHookIntoSettings(legacy));
  assert.equal(out.hooks.StopFailure.length, 1);
  const cmd = out.hooks.StopFailure[0].hooks[0].command;
  assert.match(cmd, /unsnooze\.js"? _hook-stopfailure/);
  assert.ok(!cmd.includes('csg.js'));
});

test('stripFencedBlock leaves untouched content when no block', () => {
  const { content, found } = stripFencedBlock('a\nb\n', '# >>> x >>>', '# <<< x <<<');
  assert.equal(found, false);
  assert.equal(content, 'a\nb\n');
});

test('wrapper falls back to the real CLI when the unsnooze entry point is gone', () => {
  // Regression: renaming/deleting bin/*.js while a wrapper still pointed at it
  // bricked the `claude` command entirely (MODULE_NOT_FOUND on every launch).
  const { content } = installZshrcBlock('', ['claude']);
  const guard = content.match(/if \[ "\$\{UNSNOOZE_ACTIVE\}" = "1" \] \|\| \[ ! -f "([^"]+)" \]/);
  assert.ok(guard, 'wrapper must check the entry point exists before exec-ing it');
  assert.match(guard[1], /unsnooze\.js$/);
});

test('settings hook command is guarded so a missing entry point exits 0', () => {
  const out = JSON.parse(mergeHookIntoSettings('{}'));
  const cmd = out.hooks.StopFailure[0].hooks[0].command;
  assert.match(cmd, /test -f .*unsnooze\.js.*&&/, 'hook must no-op (exit 0) when the entry point is gone');
});

test('wrapper block contains one function per enabled agent, routed via _run', () => {
  const { content } = installZshrcBlock('', ['claude', 'codex']);
  assert.match(content, /claude\(\) \{/);
  assert.match(content, /codex\(\) \{/);
  assert.ok(!content.includes('grok()'), 'disabled agents get no wrapper');
  assert.match(content, /_run claude "\$@"/);
  assert.match(content, /_run codex "\$@"/);
  assert.match(content, /UNSNOOZE_ACTIVE/);
});

test('cmdInstall creates the settings parent directory when missing', () => {
  // Regression: a machine without ~/.claude/ crashed `unsnooze setup` with
  // ENOENT — atomicWrite assumed the parent directory existed.
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-install-test-'));
  try {
    const settings = join(dir, '.claude', 'settings.json');   // .claude does not exist yet
    const rc = join(dir, '.zshrc');
    const code = cmdInstall(['--yes', '--settings', settings, '--zshrc', rc], { agents: ['claude'] });
    assert.equal(code, 0);
    assert.ok(existsSync(settings), 'settings.json must be created');
    assert.ok(JSON.parse(readFileSync(settings, 'utf-8')).hooks.StopFailure);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-installing with a different agent set replaces the block', () => {
  const first = installZshrcBlock('', ['claude', 'codex', 'grok']).content;
  const second = installZshrcBlock(first, ['claude']).content;
  assert.ok(!second.includes('codex()'));
  assert.ok(!second.includes('grok()'));
  assert.match(second, /claude\(\) \{/);
  assert.equal(second.split('# >>> unsnooze >>>').length, 2);
});
