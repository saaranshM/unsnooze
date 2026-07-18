// The single remote entrypoint for fleet control. Borg-style: under a
// forced command (authorized_keys `command="unsnooze _remote",restrict`),
// the client's request arrives in SSH_ORIGINAL_COMMAND and is re-validated
// against the same closed verb set — client env/argv is never trusted.
// Output is exactly one sentinel-framed JSON line; typing NEVER happens
// here (resume only marks state; the local daemon's gates do the rest).
import { hostname } from 'node:os';
import { isAbsolute } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { frameEnvelope, KEY_RE, PAYLOAD_RE, QUEUE_ID_RE, SCHEMA, MIN_SCHEMA } from './fleet.js';
import { readState, setStatus } from './state.js';
import { selectKeys, markResumeNow } from './cli.js';
import { PKG_VERSION } from './update-check.js';
import { queueAdd, queueList, queueRemove, queueClear, sanitizePrompt } from './prompt-queue.js';
import { listAgents } from './agents/index.js';
import { getConfig } from './settings.js';

const VERBS = new Set(['status', 'resume', 'cancel', 'queue-add', 'queue-list', 'queue-remove', 'queue-clear']);
const QUEUE_VERBS = new Set(['queue-add', 'queue-list', 'queue-remove', 'queue-clear']);
// Verbs that take no argument at all — everything else takes exactly one.
const NO_ARG_VERBS = new Set(['status', 'queue-list', 'queue-clear']);
// Per-verb single-arg shape. resume/cancel keep the original session-key
// regex; the two new verbs that carry an arg get their own (see fleet.js).
const ARG_VALIDATORS = { resume: KEY_RE, cancel: KEY_RE, 'queue-add': PAYLOAD_RE, 'queue-remove': QUEUE_ID_RE };

// Mirrors prompt-queue.js's own AGENT_IDS/MODES/MAX_CWD_LEN — deliberately
// re-declared here rather than imported: this module re-validates every
// field independently of queueAdd's own checks (defense in depth for
// attacker-shaped SSH input), and a shared constant would blur that these
// are two separate gates, not one.
const AGENT_IDS = new Set(listAgents().map(a => a.id));
const QUEUE_MODES = ['next-reset', 'at', 'now'];
const MAX_CWD_LEN = 1024;
const QUEUE_STATUS_CAP = 50;

function handshake() {
  return {
    schema: SCHEMA,
    minSchema: MIN_SCHEMA,
    cli: PKG_VERSION,
    host: hostname(),
    caps: ['resume', 'cancel', 'queue'],
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

// Minimal, capped subset for the wire — shared by the `status` envelope's
// `queue` field and the `queue-list` verb's reply. Every field here is
// already sanitized at creation time (sanitizePrompt in queueAdd), but the
// emitter's subset stays minimal on top of that rather than leaning on
// "the client re-sanitizes anyway" as the only guard.
function queueEnvelopeEntries() {
  return queueList().slice(0, QUEUE_STATUS_CAP).map(e => ({
    id: e.id,
    agent: e.agent,
    cwd: e.cwd,
    status: e.status,
    mode: e.mode,
    atMs: Number.isFinite(e.atMs) ? e.atMs : null,
    notBefore: Number.isFinite(e.notBefore) ? e.notBefore : null,
    attempts: Number.isFinite(e.attempts) ? e.attempts : 0,
    deliveredAt: Number.isFinite(e.deliveredAt) ? e.deliveredAt : null,
    lastError: e.lastError ?? null,
    promptPreview: typeof e.prompt === 'string' ? e.prompt.slice(0, 80) : '',
  }));
}

// base64url-decode -> JSON.parse -> re-validate every field into a fresh
// object literal. Never spreads the parsed object (prototype-pollution /
// field-smuggling defense, same rule fleet.js's sanitizeSession follows) —
// only these five named properties are ever read off `parsed`, so a hostile
// `__proto__`/`constructor`/extra-field payload has nothing to smuggle
// through. Returns null for anything that doesn't check out; the caller
// turns that into a flat 'bad-request'.
function decodeQueueAddPayload(payload) {
  let json;
  try {
    json = Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const cwd = parsed.cwd;
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > MAX_CWD_LEN) return null;
  try {
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return null;
  } catch {
    return null;
  }

  const agent = parsed.agent;
  if (typeof agent !== 'string' || !AGENT_IDS.has(agent)) return null;

  const prompt = sanitizePrompt(parsed.prompt);
  if (!prompt) return null;

  const mode = parsed.mode;
  if (!QUEUE_MODES.includes(mode)) return null;

  let atMs = null;
  if (mode === 'at') {
    if (!Number.isFinite(parsed.atMs)) return null;
    atMs = parsed.atMs;
  }

  return { cwd, agent, prompt, mode, atMs };
}

// Parse the verb either from our argv or, under a forced command, from
// SSH_ORIGINAL_COMMAND ("unsnooze _remote <verb> [arg]"). Reject anything
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
  const [verb, arg, ...extra] = tokens;
  if (!VERBS.has(verb)) return null;
  if (extra.length > 0) return null;   // no verb takes more than one arg
  if (NO_ARG_VERBS.has(verb)) {
    if (arg != null) return null;
    return { verb, arg: null };
  }
  const validator = ARG_VALIDATORS[verb];
  if (arg == null || !validator.test(arg)) return null;
  return { verb, arg };
}

export async function cmdRemote(args = []) {
  const emit = (extra) => console.log(frameEnvelope({ ...handshake(), ...extra }));
  try {
    const req = resolveRequest(args);
    if (!req) {
      emit({ result: 'bad-request' });
      return 1;
    }

    // Per-host opt-out: a host can refuse all four queue verbs regardless of
    // what the controller asks for. Still a valid framed envelope — the
    // controller needs a real, typed answer to tell "disabled" apart from
    // "too old to know the verb" (see fleet.js's queueVerbCall).
    if (QUEUE_VERBS.has(req.verb) && !getConfig('remoteQueue')) {
      emit({ result: 'disabled' });
      return 1;
    }

    if (req.verb === 'queue-add') {
      const fresh = decodeQueueAddPayload(req.arg);
      if (!fresh) {
        emit({ result: 'bad-request' });
        return 1;
      }
      // UNSNOOZE_REMOTE_TEST_NO_SPAWN is remote.js's own test-only escape
      // hatch: queueAdd's spawn-on-success side effect (spawnResumerIfNeeded)
      // is normal, wanted production behavior here (a remote host needs a
      // resumer running to ever deliver the prompt) but has no wire-protocol
      // way to opt out, unlike the local CLI's `spawn: false`. Tests that
      // exercise this verb via a real subprocess (execFileSync) must not let
      // that subprocess fork a real detached daemon — see remote.test.js.
      const spawn = process.env.UNSNOOZE_REMOTE_TEST_NO_SPAWN !== '1';
      const result = queueAdd({ ...fresh, createdBy: 'remote', spawn });
      if (!result.ok) {
        emit({ result: 'error', error: result.error });
        return 1;
      }
      emit({ result: 'ok', id: result.entry.id });
      return 0;
    }
    if (req.verb === 'queue-list') {
      emit({ result: 'ok', queue: queueEnvelopeEntries() });
      return 0;
    }
    if (req.verb === 'queue-remove') {
      const removed = queueRemove(req.arg);
      emit({ result: removed ? 'ok' : 'not-found' });
      return removed ? 0 : 1;
    }
    if (req.verb === 'queue-clear') {
      const cleared = queueClear();
      emit({ result: 'ok', cleared });
      return 0;
    }

    const state = readState();
    if (req.verb === 'status') {
      emit({ resumerAlive: !!state.resumerPid, sessions: sessionsPayload(state), queue: queueEnvelopeEntries() });
      return 0;
    }
    const keys = selectKeys(state, req.arg);
    if (keys.length === 0) {
      emit({ result: 'no-match', matched: [] });
      return 1;
    }
    if (req.verb === 'resume') markResumeNow(keys);
    else for (const k of keys) setStatus(k, 'cancelled');
    emit({ result: 'ok', matched: keys });
    return 0;
  } catch {
    emit({ result: 'error' });
    return 1;
  }
}
