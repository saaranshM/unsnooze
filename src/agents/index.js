// Agent registry. Every supported CLI gets an adapter; unknown ids fall back
// to claude (pre-adapter state records have no agent field).

import claude from './claude.js';
import codex from './codex.js';

const REGISTRY = { claude, codex };

export function getAgent(id) {
  return REGISTRY[id] || claude;
}

export function listAgents() {
  return Object.values(REGISTRY);
}
