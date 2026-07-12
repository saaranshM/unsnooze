// Agent registry. Every supported CLI gets an adapter; unknown ids fall back
// to claude (pre-adapter state records have no agent field).

import claude from './claude.js';
import codex from './codex.js';
import grok from './grok.js';
import qwen from './qwen.js';
import kimi from './kimi.js';
import opencode from './opencode.js';
import agy from './agy.js';

const REGISTRY = { claude, codex, grok, qwen, kimi, opencode, agy };

export function getAgent(id) {
  return REGISTRY[id] || claude;
}

export function listAgents() {
  return Object.values(REGISTRY);
}
