// User-facing settings: ~/.unsnooze/config.json, managed by `unsnooze config`
// and the setup wizard. Precedence per key: env var > config file > default —
// env stays the power-user/test escape hatch, the file is what the wizard
// writes. One cross-key exception: the resume message resolves by specificity
// first, so a per-agent resumeMessages.<id> value (from either source) beats
// the global resumeMessage even when the global came from an env var (see
// resolveResumeMessage).

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { STATE_DIR } from './config.js';

export const CONFIG_FILE = () => join(process.env.UNSNOOZE_STATE_DIR || STATE_DIR, 'config.json');

export const DEFAULTS = {
  multiplexer: 'auto',    // auto | tmux | zellij
  autoResume: true,        // master switch: dispatch resumes when limits reset
  menuAutoAnswer: true,    // may unsnooze drive Claude's limit menu (send keys)?
  notifications: true,     // desktop notifications on detect/resume
  notifyChannel: 'auto',   // auto | native | osc | bell
  // ntfy push (https://ntfy.sh) — ADDITIVE to notifyChannel; off until a
  // topic is set. ntfy.sh topics are public: the name is the password —
  // use `unsnooze config set ntfyTopic $(unsnooze doctor)`-style random
  // names (generateNtfyTopic) or a self-hosted/authed server.
  ntfyTopic: '',           // '' = ntfy off
  ntfyServer: 'https://ntfy.sh',
  ntfyToken: '',           // optional Bearer token (tk_…) for authed servers
  ntfyPrivacy: 'full',     // full | terse (terse: never push cwd paths)
  guiWatch: true,          // daemon watches transcripts/rollouts for GUI-session stops
  updateCheck: true,       // daily registry version check + update notices/toast
  workspaceGuard: 'inform', // repo changed while stopped: off | inform | pause
  contextGuard: 'inform',   // wake re-reads a big cold context: off | inform | pause
  contextGuardTokens: 100_000, // contextGuard notify/hold threshold (tokens)
  // Pre-wall usage warnings (1.13): daemon notifies at % bands + ETA tiers.
  usageWarn: 'notify',     // off | notify
  usageWarnAt: '80,95',    // % thresholds (comma-separated); garbage → default
  mouse: true,             // dashboard mouse support (click tabs/rows, wheel scroll)
  // Opt-in: auto-close `resumed` panes idle longer than reapIdleAfter (ms).
  // Off by default — an idle revived TUI is indistinguishable from one the
  // user will return to. Explicit cleanup: `unsnooze reap --yes`.
  reapResumed: false,
  reapIdleAfter: 7 * 86_400_000,
  resumeMessage: 'Continue where you left off. The session was interrupted by a usage limit which has now reset — pick up the task you were working on and finish it.',
  resumeMessages: { claude: '', codex: '', grok: '', qwen: '', kimi: '', opencode: '', agy: '' },  // per-agent override; '' = use resumeMessage
  agents: { claude: true, codex: true, grok: false, qwen: false, kimi: false, opencode: false, agy: false },   // experimental agents default off
};

// Env override per key. Booleans accept 1/0, true/false, on/off, yes/no.
const ENV_NAMES = {
  multiplexer: 'UNSNOOZE_MULTIPLEXER',
  autoResume: 'UNSNOOZE_AUTO_RESUME',
  menuAutoAnswer: 'UNSNOOZE_MENU_AUTO_ANSWER',
  notifications: 'UNSNOOZE_NOTIFICATIONS',
  notifyChannel: 'UNSNOOZE_NOTIFY_CHANNEL',
  ntfyTopic: 'UNSNOOZE_NTFY_TOPIC',
  ntfyServer: 'UNSNOOZE_NTFY_SERVER',
  ntfyToken: 'UNSNOOZE_NTFY_TOKEN',
  ntfyPrivacy: 'UNSNOOZE_NTFY_PRIVACY',
  guiWatch: 'UNSNOOZE_GUI_WATCH',
  updateCheck: 'UNSNOOZE_UPDATE_CHECK',
  workspaceGuard: 'UNSNOOZE_WORKSPACE_GUARD',
  contextGuard: 'UNSNOOZE_CONTEXT_GUARD',
  contextGuardTokens: 'UNSNOOZE_CONTEXT_GUARD_TOKENS',
  usageWarn: 'UNSNOOZE_USAGE_WARN',
  usageWarnAt: 'UNSNOOZE_USAGE_WARN_AT',
  mouse: 'UNSNOOZE_MOUSE',
  reapResumed: 'UNSNOOZE_REAP_RESUMED',
  reapIdleAfter: 'UNSNOOZE_REAP_IDLE_AFTER',
  resumeMessage: 'UNSNOOZE_RESUME_MESSAGE',
  'resumeMessages.claude': 'UNSNOOZE_RESUME_MESSAGE_CLAUDE',
  'resumeMessages.codex': 'UNSNOOZE_RESUME_MESSAGE_CODEX',
  'resumeMessages.grok': 'UNSNOOZE_RESUME_MESSAGE_GROK',
  'resumeMessages.qwen': 'UNSNOOZE_RESUME_MESSAGE_QWEN',
  'resumeMessages.kimi': 'UNSNOOZE_RESUME_MESSAGE_KIMI',
  'resumeMessages.opencode': 'UNSNOOZE_RESUME_MESSAGE_OPENCODE',
  'resumeMessages.agy': 'UNSNOOZE_RESUME_MESSAGE_AGY',
  'agents.claude': 'UNSNOOZE_AGENT_CLAUDE',
  'agents.codex': 'UNSNOOZE_AGENT_CODEX',
  'agents.grok': 'UNSNOOZE_AGENT_GROK',
  'agents.qwen': 'UNSNOOZE_AGENT_QWEN',
  'agents.kimi': 'UNSNOOZE_AGENT_KIMI',
  'agents.opencode': 'UNSNOOZE_AGENT_OPENCODE',
  'agents.agy': 'UNSNOOZE_AGENT_AGY',
};

const KNOWN_KEYS = Object.keys(ENV_NAMES);

// String settings restricted to a fixed set of values.
const ENUMS = {
  multiplexer: ['auto', 'tmux', 'zellij'],
  workspaceGuard: ['off', 'inform', 'pause'],
  contextGuard: ['off', 'inform', 'pause'],
  notifyChannel: ['auto', 'native', 'osc', 'bell'],
  ntfyPrivacy: ['full', 'terse'],
  usageWarn: ['off', 'notify'],
};

function parseBool(raw) {
  if (/^(1|true|on|yes)$/i.test(raw)) return true;
  if (/^(0|false|off|no)$/i.test(raw)) return false;
  return null;
}

export function readFileConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE(), 'utf-8'));
    // Wrong-typed but valid JSON (a bare string/array) counts as corrupt too.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};   // missing or corrupt file → defaults (never crash the hook path)
  }
}

function dig(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function getConfig(key) {
  if (!KNOWN_KEYS.includes(key)) throw new Error(`unsnooze: unknown setting "${key}"`);
  const def = dig(DEFAULTS, key);
  const env = process.env[ENV_NAMES[key]];
  if (env !== undefined && env !== '') {
    if (typeof def === 'boolean') {
      const b = parseBool(env);
      if (b !== null) return b;
    } else if (typeof def === 'number') {
      const n = parseInt(env, 10);
      if (Number.isFinite(n)) return n;
    } else {
      return env;
    }
  }
  const fromFile = dig(readFileConfig(), key);
  if (fromFile === undefined) return def;
  if (typeof def === 'number') {
    // Hand-edited files may hold anything; a non-numeric value must not
    // silently disable a threshold — fall back to the default instead.
    const n = Number(fromFile);
    return Number.isFinite(n) ? n : def;
  }
  return fromFile;
}

// The message to send a given agent: its resumeMessages.<id> override when
// set, else the global resumeMessage. Unknown agent ids fall back to global;
// blank values (empty or whitespace-only) fall through to the next level so a
// blank message is never sent.
export function resolveResumeMessage(agentId) {
  const key = `resumeMessages.${agentId}`;
  const set = v => (typeof v === 'string' && v.trim() ? v : '');
  const perAgent = agentId && KNOWN_KEYS.includes(key) ? getConfig(key) : '';
  return set(perAgent) || set(getConfig('resumeMessage')) || DEFAULTS.resumeMessage;
}

export function setConfigValue(key, rawValue) {
  if (!KNOWN_KEYS.includes(key)) throw new Error(`unsnooze: unknown setting "${key}" (known: ${KNOWN_KEYS.join(', ')})`);
  const def = dig(DEFAULTS, key);
  let value = rawValue;
  if (typeof def === 'boolean') {
    const b = typeof rawValue === 'boolean' ? rawValue : parseBool(String(rawValue));
    if (b === null) throw new Error(`unsnooze: "${key}" needs a boolean (on/off, true/false)`);
    value = b;
  } else if (typeof def === 'number') {
    const n = parseInt(String(rawValue), 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`unsnooze: "${key}" needs a positive integer`);
    value = n;
  } else {
    value = String(rawValue);
    if (ENUMS[key] && !ENUMS[key].includes(value)) {
      throw new Error(`unsnooze: "${key}" must be one of: ${ENUMS[key].join(', ')}`);
    }
  }
  const config = readFileConfig();
  const parts = key.split('.');
  let cursor = config;
  for (const part of parts.slice(0, -1)) {
    if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
  writeConfig(config);
  return value;
}

export function writeConfig(config) {
  const path = CONFIG_FILE();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.config.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  renameSync(tmp, path);
}

export function configFileExists() {
  try { readFileSync(CONFIG_FILE()); return true; } catch { return false; }
}

export function listConfig() {
  const out = {};
  for (const key of KNOWN_KEYS) out[key] = getConfig(key);
  return out;
}
