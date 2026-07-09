// Agent registry. Every supported CLI gets an adapter; unknown ids fall back
// to claude (pre-adapter state records have no agent field).

import claude from './claude.js';

const REGISTRY = { claude };

export function getAgent(id) {
  return REGISTRY[id] || claude;
}

export function listAgents() {
  return Object.values(REGISTRY);
}
