import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectInstalledAgents } from '../src/wizard.js';
import { listAgents } from '../src/agents/index.js';

test('detectInstalledAgents reports every registered agent with install state', () => {
  const found = detectInstalledAgents({ which: bin => bin === 'claude' });
  const ids = found.map(f => f.agent.id);
  assert.deepEqual(ids.sort(), listAgents().map(a => a.id).sort());
  assert.equal(found.find(f => f.agent.id === 'claude').installed, true);
  assert.equal(found.find(f => f.agent.id === 'codex').installed, false);
});
