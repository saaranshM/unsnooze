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
  assert.match(cmd, /csg\.js _hook-stopfailure/);
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
  assert.ok(content.includes('# >>> claude-session-guard >>>'));
  assert.ok(content.includes("alias ll='ls -la'"));
  assert.ok(content.includes('export PATH=$PATH:/foo'));
  // Idempotent: installing again yields exactly one block
  const again = installZshrcBlock(content).content;
  assert.equal(again.split('# >>> claude-session-guard >>>').length, 2);
});

test('stripFencedBlock leaves untouched content when no block', () => {
  const { content, found } = stripFencedBlock('a\nb\n', '# >>> x >>>', '# <<< x <<<');
  assert.equal(found, false);
  assert.equal(content, 'a\nb\n');
});
