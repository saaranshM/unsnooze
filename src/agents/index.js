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

// v1: every agent launches the bare TUI and gets the prompt typed once idle.
function defaultLaunchArgs(message) { return { args: [], messageViaPane: true }; }

export function getAgent(id) {
  const agent = REGISTRY[id] || claude;
  // Third-party/partial adapters may lack launchArgs — synthesize the same
  // default so callers (dispatch, tests) never have to null-check it.
  return typeof agent.launchArgs === 'function' ? agent : { ...agent, launchArgs: defaultLaunchArgs };
}

export function listAgents() {
  return Object.values(REGISTRY);
}
