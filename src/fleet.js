// Fleet: see and manage unsnooze sessions on other machines over the user's
// own OpenSSH. Pull model — no ports, no custom auth, no new deps. The
// remote daemon does all typing under its own gates; this side only views
// and marks. Security invariants (see plans/multi-host-sessions.md):
// allowlisted host tokens, closed verb set, sentinel-framed JSON, and
// control-char-stripped ingest.
import { join } from 'node:path';
import { STATE_DIR } from './config.js';

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
//   - C0 controls (excl. TAB/LF), DEL, and any leftover single C1 byte
// Alternation order matters: the multi-byte sequence forms are tried before
// the single-byte catch-all so a C1 introducer (e.g. \x9b) consumes its
// whole sequence instead of being stripped alone and leaking its payload.
// (The Terminal DiLLMa / Codex-CLI ANSI-injection class.)
/* eslint-disable no-control-regex */
const VT_RE =
  /(?:\x1bP|\x90)[^\x1b\x9c]*(?:\x1b\\|\x9c)?|(?:\x1b[X^_]|[\x98\x9e\x9f])[^\x1b\x9c]*(?:\x1b\\|\x9c)?|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|(?:\x1b\[|\x9b)[0-9:;<=>?]*[ -/]*[@-~]?|\x1b[ -~]?|[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g;

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
