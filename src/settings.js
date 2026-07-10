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
  autoResume: true,        // master switch: dispatch resumes when limits reset
  menuAutoAnswer: true,    // may unsnooze drive Claude's limit menu (send keys)?
  notifications: true,     // desktop notifications on detect/resume
  resumeMessage: 'Continue where you left off. The session was interrupted by a usage limit which has now reset — pick up the task you were working on and finish it.',
  resumeMessages: { claude: '', codex: '', grok: '' },  // per-agent override; '' = use resumeMessage
  agents: { claude: true, codex: true, grok: false },   // grok is experimental
};

// Env override per key. Booleans accept 1/0, true/false, on/off, yes/no.
const ENV_NAMES = {
  autoResume: 'UNSNOOZE_AUTO_RESUME',
  menuAutoAnswer: 'UNSNOOZE_MENU_AUTO_ANSWER',
  notifications: 'UNSNOOZE_NOTIFICATIONS',
  resumeMessage: 'UNSNOOZE_RESUME_MESSAGE',
  'resumeMessages.claude': 'UNSNOOZE_RESUME_MESSAGE_CLAUDE',
  'resumeMessages.codex': 'UNSNOOZE_RESUME_MESSAGE_CODEX',
  'resumeMessages.grok': 'UNSNOOZE_RESUME_MESSAGE_GROK',
  'agents.claude': 'UNSNOOZE_AGENT_CLAUDE',
  'agents.codex': 'UNSNOOZE_AGENT_CODEX',
  'agents.grok': 'UNSNOOZE_AGENT_GROK',
};

const KNOWN_KEYS = Object.keys(ENV_NAMES);

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
    } else {
      return env;
    }
  }
  const fromFile = dig(readFileConfig(), key);
  return fromFile !== undefined ? fromFile : def;
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
  } else {
    value = String(rawValue);
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
