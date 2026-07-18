// launchArgs: v1 contract — every agent launches the bare TUI and gets the
// prompt typed once idle. codex/kimi argv resume forms are deferred; do not
// let launchArgs diverge per-agent yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAgent, listAgents } from '../src/agents/index.js';
import claudeAgent from '../src/agents/claude.js';

test('every registered agent: launchArgs(message) returns the v1 default', () => {
  for (const agent of listAgents()) {
    const result = agent.launchArgs('hello');
    assert.deepEqual(result, { args: [], messageViaPane: true }, `${agent.id} launchArgs`);
  }
});

test('getAgent synthesizes launchArgs for a registry adapter missing the method', () => {
  const original = claudeAgent.launchArgs;
  delete claudeAgent.launchArgs;
  try {
    const agent = getAgent('claude');
    assert.equal(typeof agent.launchArgs, 'function');
    assert.deepEqual(agent.launchArgs('msg'), { args: [], messageViaPane: true });
  } finally {
    claudeAgent.launchArgs = original;
  }
});
