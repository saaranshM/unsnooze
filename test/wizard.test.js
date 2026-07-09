import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectInstalledAgents } from '../src/wizard.js';

test('detectInstalledAgents reports every registered agent with install state', () => {
  const found = detectInstalledAgents({ which: bin => bin === 'claude' });
  const ids = found.map(f => f.agent.id);
  assert.deepEqual(ids.sort(), ['claude', 'codex', 'grok']);
  assert.equal(found.find(f => f.agent.id === 'claude').installed, true);
  assert.equal(found.find(f => f.agent.id === 'codex').installed, false);
});
