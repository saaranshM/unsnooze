import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeHookIntoSettings, removeHookFromSettings, installZshrcBlock, stripFencedBlock,
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
  assert.match(cmd, /unsnooze\.js _hook-stopfailure/);
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
  assert.match(cmd, /unsnooze\.js _hook-stopfailure/);
  assert.ok(!cmd.includes('csg.js'));
});

test('stripFencedBlock leaves untouched content when no block', () => {
  const { content, found } = stripFencedBlock('a\nb\n', '# >>> x >>>', '# <<< x <<<');
  assert.equal(found, false);
  assert.equal(content, 'a\nb\n');
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

test('re-installing with a different agent set replaces the block', () => {
  const first = installZshrcBlock('', ['claude', 'codex', 'grok']).content;
  const second = installZshrcBlock(first, ['claude']).content;
  assert.ok(!second.includes('codex()'));
  assert.ok(!second.includes('grok()'));
  assert.match(second, /claude\(\) \{/);
  assert.equal(second.split('# >>> unsnooze >>>').length, 2);
});
