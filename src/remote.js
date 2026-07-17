// The single remote entrypoint for fleet control. Borg-style: under a
// forced command (authorized_keys `command="unsnooze _remote",restrict`),
// the client's request arrives in SSH_ORIGINAL_COMMAND and is re-validated
// against the same closed verb set — client env/argv is never trusted.
// Output is exactly one sentinel-framed JSON line; typing NEVER happens
// here (resume only marks state; the local daemon's gates do the rest).
import { hostname } from 'node:os';
import { frameEnvelope, KEY_RE, SCHEMA, MIN_SCHEMA } from './fleet.js';
import { readState, setStatus } from './state.js';
import { selectKeys, markResumeNow } from './cli.js';
import { PKG_VERSION } from './update-check.js';

const VERBS = new Set(['status', 'resume', 'cancel']);

function handshake() {
  return {
    schema: SCHEMA,
    minSchema: MIN_SCHEMA,
    cli: PKG_VERSION,
    host: hostname(),
    caps: ['resume', 'cancel'],
  };
}

function sessionsPayload(state) {
  return Object.values(state.sessions ?? {}).map(s => ({
    key: s.key, sessionId: s.sessionId ?? null, agent: s.agent ?? 'claude',
    cwd: s.cwd ?? null, status: s.status, limitType: s.limitType ?? null,
    resetAt: s.resetAt ?? null, resetSource: s.resetSource ?? null,
    mux: s.mux ?? null, pane: s.pane ?? null, muxSession: s.muxSession ?? null,
    attempts: s.attempts ?? 0, lastError: s.lastError ?? null,
    workspaceHold: !!s.workspaceHold,
  }));
}

// Parse the verb either from our argv or, under a forced command, from
// SSH_ORIGINAL_COMMAND ("unsnooze _remote <verb> [key]"). Reject anything
// that isn't exactly that shape — no shell ever sees these tokens again,
// but defense in depth costs one regex.
function resolveRequest(args) {
  let tokens = args;
  if (tokens.length === 0 && process.env.SSH_ORIGINAL_COMMAND) {
    const parts = process.env.SSH_ORIGINAL_COMMAND.trim().split(/\s+/);
    if (parts.length < 2 || parts.length > 4) return null;
    if (!/(^|\/)unsnooze$/.test(parts[0]) || parts[1] !== '_remote') return null;
    tokens = parts.slice(2);
  }
  const [verb, key, ...extra] = tokens;
  if (!VERBS.has(verb)) return null;
  if (extra.length > 0) return null;   // no verb takes more than one arg
  if (verb !== 'status' && (key == null || !KEY_RE.test(key))) return null;
  if (verb === 'status' && key != null) return null;
  return { verb, key };
}

export async function cmdRemote(args = []) {
  const req = resolveRequest(args);
  const emit = (extra) => console.log(frameEnvelope({ ...handshake(), ...extra }));
  if (!req) {
    emit({ result: 'bad-request' });
    return 1;
  }
  const state = readState();
  if (req.verb === 'status') {
    emit({ resumerAlive: !!state.resumerPid, sessions: sessionsPayload(state) });
    return 0;
  }
  const keys = selectKeys(state, req.key);
  if (keys.length === 0) {
    emit({ result: 'no-match', matched: [] });
    return 1;
  }
  if (req.verb === 'resume') markResumeNow(keys);
  else for (const k of keys) setStatus(k, 'cancelled');
  emit({ result: 'ok', matched: keys });
  return 0;
}
