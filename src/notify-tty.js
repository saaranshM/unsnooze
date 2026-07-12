// Terminal-branded notifications via OSC to client tty + BEL to pane tty.
//
// Dialect support matrix:
//   OSC 9  (\x1b]9;title: body\x07)  — iterm2, kitty, wezterm, ghostty, warp
//   OSC 777 (\x1b]777;notify;title;body\x07) — rxvt only
//   unsupported (Apple_Terminal, vscode, alacritty, zed) — skip in auto
//   unknown (null) — skip in auto; OSC 9 when force
//
// force (notifyChannel=osc): unknown always gets OSC 9. Denylist from
// per-client evidence (termname / caller env) always blocks under force —
// including when globalEnv is *also* denylisted (server layer would otherwise
// shadow caller). Denylist from globalEnv alone does not block force (stale
// show-environment -g after reattach). Auto is unchanged: any unsupported
// source is skipped.
//
// One-write rule: open O_WRONLY|O_NOCTTY|O_NONBLOCK, exactly one write of the
// whole sequence (<1 KB), no retry on short write (fail fast under O_NONBLOCK
// / frozen clients). Never acquire a controlling terminal. All errors
// swallowed. All deps injectable — never touch a real tty from tests.

import nodeFs from 'node:fs';

const TITLE_MAX = 100;
const BODY_MAX = 200;

/** Server-side env keys used for terminal brand detection (tmux show-environment -g). */
export const DETECT_ENV_NAMES = [
  'TERM_PROGRAM',
  'LC_TERMINAL',
  'KITTY_WINDOW_ID',
  'WEZTERM_EXECUTABLE',
  'GHOSTTY_RESOURCES_DIR',
  'TERM',
];

// C0 controls (0x00–0x1F) and DEL (0x7F) — includes ESC and BEL.
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

/**
 * Strip C0/DEL/ESC/BEL, collapse newlines to spaces, truncate to max.
 * When stripSemicolons is set (OSC 777 title and body), also remove `;`
 * field separators.
 */
export function sanitizeOscText(s, max = TITLE_MAX, { stripSemicolons = false } = {}) {
  let t = String(s ?? '');
  // Collapse newlines (and CR) to a single space before stripping other C0.
  t = t.replace(/[\r\n]+/g, ' ');
  t = t.replace(CONTROL_RE, '');
  if (stripSemicolons) t = t.replace(/;/g, '');
  // Collapse runs of spaces left by newline collapse / stripped controls.
  t = t.replace(/ {2,}/g, ' ').trim();
  if (typeof max === 'number' && max >= 0 && t.length > max) t = t.slice(0, max);
  return t;
}

/** OSC 9: `\x1b]9;title: body\x07` */
export function buildOsc9(title, body) {
  const t = sanitizeOscText(title, TITLE_MAX);
  const b = sanitizeOscText(body, BODY_MAX);
  return `\x1b]9;${t}: ${b}\x07`;
}

/** OSC 777 (rxvt notify): `\x1b]777;notify;title;body\x07` — `;` stripped from title and body. */
export function buildOsc777(title, body) {
  const t = sanitizeOscText(title, TITLE_MAX, { stripSemicolons: true });
  const b = sanitizeOscText(body, BODY_MAX, { stripSemicolons: true });
  return `\x1b]777;notify;${t};${b}\x07`;
}

function termnameBrand(termname) {
  if (!termname) return null;
  const n = String(termname).toLowerCase();
  if (n.includes('kitty')) return 'kitty';
  if (n.includes('ghostty')) return 'ghostty';
  if (n.includes('wezterm')) return 'wezterm';
  // rxvt, rxvt-unicode, rxvt-unicode-256color, etc.
  if (n.includes('rxvt')) return 'rxvt';
  return null;
}

function envBrand(env = {}) {
  if (!env || typeof env !== 'object') return null;
  const termProgram = String(env.TERM_PROGRAM || '');
  const lcTerminal = String(env.LC_TERMINAL || '');
  const term = String(env.TERM || '');

  // Known good brands (env presence / TERM_PROGRAM / LC_TERMINAL).
  if (/^iterm/i.test(termProgram) || /^iterm/i.test(lcTerminal)) return 'iterm2';
  if (/^warp/i.test(termProgram) || /^warp/i.test(lcTerminal)) return 'warp';
  if (env.KITTY_WINDOW_ID) return 'kitty';
  if (env.WEZTERM_EXECUTABLE) return 'wezterm';
  if (env.GHOSTTY_RESOURCES_DIR) return 'ghostty';
  if (/rxvt/i.test(term)) return 'rxvt';

  return null;
}

const DENY_TERM_PROGRAM = new Set([
  'apple_terminal', 'vscode', 'alacritty', 'zed',
]);

function isDenied({ termname, env = {} }) {
  const termProgram = String(env.TERM_PROGRAM || '').toLowerCase();
  if (DENY_TERM_PROGRAM.has(termProgram)) return true;
  if (termProgram.includes('apple_terminal')) return true;

  const term = String(env.TERM || '').toLowerCase();
  const name = String(termname || '').toLowerCase();
  // Alacritty often reports TERM=alacritty rather than TERM_PROGRAM.
  if (term.includes('alacritty') || name.includes('alacritty')) return true;
  if (name === 'vscode' || name.includes('vscode')) return true;
  if (name === 'zed' || name.startsWith('zed')) return true;
  // Symmetry with TERM_PROGRAM denylist (rarely seen as termname, but cheap).
  if (name.includes('apple_terminal')) return true;
  return false;
}

/**
 * Classify a terminal brand from client termname and/or env.
 * @returns {'iterm2'|'kitty'|'wezterm'|'ghostty'|'warp'|'rxvt'|'unsupported'|null}
 */
export function classifyTerminal({ termname = null, env = {} } = {}) {
  // (1) termname layer — per-client #{client_termname}
  const fromName = termnameBrand(termname);
  if (fromName) return fromName;

  // (3) denylist before unknown env brands that might be ambiguous
  if (isDenied({ termname, env })) return 'unsupported';

  // (2) env layer — TERM_PROGRAM / LC_TERMINAL / presence vars / TERM
  const fromEnv = envBrand(env);
  if (fromEnv) return fromEnv;

  return null;
}

/** Map brand → OSC dialect. unsupported/null → null. */
export function dialectFor(terminal) {
  switch (terminal) {
    case 'iterm2':
    case 'kitty':
    case 'wezterm':
    case 'ghostty':
    case 'warp':
      return 'osc9';
    case 'rxvt':
      return 'osc777';
    default:
      return null;
  }
}

/**
 * Write data to a tty path: one open, one write, close. Never throws.
 * Single attempt only — short writes (bytesWritten < length) under O_NONBLOCK
 * count as failure; no retry loop so frozen clients fail fast.
 * @returns {Promise<boolean>} true only when the full buffer was written
 */
export async function writeToTty(ttyPath, data, { fs: fsMod = nodeFs } = {}) {
  let fh;
  try {
    const c = fsMod.constants || nodeFs.constants;
    const flags = c.O_WRONLY | c.O_NOCTTY | c.O_NONBLOCK;
    const open = fsMod.promises?.open?.bind(fsMod.promises) || nodeFs.promises.open;
    fh = await open(ttyPath, flags);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    // Exactly one write of the whole sequence; partial write → false.
    const result = await fh.write(buf, 0, buf.length, null);
    const written = result?.bytesWritten ?? 0;
    return written === buf.length;
  } catch {
    return false;
  } finally {
    if (fh) {
      try { await fh.close(); } catch { /* swallow */ }
    }
  }
}

function sequenceFor(dialect, title, body) {
  if (dialect === 'osc9') return buildOsc9(title, body);
  if (dialect === 'osc777') return buildOsc777(title, body);
  return null;
}

/**
 * Classify a client using layered detection:
 * termname → server env (mux.globalEnv) → caller env.
 * @returns {{ brand: string|null, source: 'termname'|'server'|'caller'|null }}
 */
function classifyClient(termname, serverEnv, callerEnv) {
  let brand = classifyTerminal({ termname, env: {} });
  if (brand != null) return { brand, source: 'termname' };
  brand = classifyTerminal({ termname, env: serverEnv || {} });
  if (brand != null) return { brand, source: 'server' };
  brand = classifyTerminal({ termname, env: callerEnv || {} });
  if (brand != null) return { brand, source: 'caller' };
  return { brand: null, source: null };
}

/**
 * Resolve OSC dialect for a classified client.
 * force (notifyChannel=osc): null → osc9; unsupported from globalEnv alone →
 * osc9 (stale server env) *unless* per-client evidence (termname / caller env)
 * independently denylists; unsupported from termname/caller still blocks.
 * Auto: unsupported from any source stays skipped.
 */
function dialectForClient(brand, source, force, { termname, callerEnv } = {}) {
  const dialect = dialectFor(brand);
  if (dialect) return dialect;
  if (!force) return null;
  if (brand == null) return 'osc9';
  // Stale show-environment -g denylist must not defeat forced OSC — but only
  // when the caller/process env and termname are not themselves denylisted.
  // classifyClient stops at the first non-null layer, so re-check per-client
  // evidence here before upgrading server unsupported → OSC 9.
  if (brand === 'unsupported' && source === 'server') {
    const perClient = classifyTerminal({ termname, env: callerEnv || {} });
    if (perClient === 'unsupported') return null;
    return 'osc9';
  }
  return null;
}

/**
 * Send OSC notification to every attached client tty for `pane`.
 * @returns {Promise<number>} number of successful tty writes
 */
export async function sendOsc(title, body, {
  mux,
  pane,
  env = process.env,
  writeTty = (path, data) => writeToTty(path, data),
  force = false,
} = {}) {
  try {
    if (!mux || typeof mux.clientTtys !== 'function') return 0;

    let clients;
    try {
      clients = await mux.clientTtys(pane);
    } catch {
      return 0;
    }
    if (!Array.isArray(clients) || clients.length === 0) return 0;

    let serverEnv = {};
    if (typeof mux.globalEnv === 'function') {
      try {
        serverEnv = (await mux.globalEnv(DETECT_ENV_NAMES)) || {};
      } catch { /* empty server env */ }
    }

    // Dedupe by tty path (multiple clients can share a path in edge cases).
    const seen = new Set();
    let delivered = 0;

    for (const client of clients) {
      const tty = client?.tty;
      if (!tty || seen.has(tty)) continue;
      seen.add(tty);

      const { brand, source } = classifyClient(client.termname, serverEnv, env);
      const dialect = dialectForClient(brand, source, force, {
        termname: client.termname,
        callerEnv: env,
      });
      if (!dialect) continue;

      const seq = sequenceFor(dialect, title, body);
      if (!seq) continue;

      try {
        const ok = await writeTty(tty, seq);
        if (ok) delivered += 1;
      } catch { /* never reject */ }
    }

    return delivered;
  } catch {
    return 0;
  }
}

/**
 * Write BEL (`\x07`) to the pane tty (resolved at send time). Never throws.
 * @returns {Promise<boolean>}
 */
export async function sendBell({
  mux,
  pane,
  writeTty = (path, data) => writeToTty(path, data),
} = {}) {
  try {
    if (!mux || typeof mux.paneTty !== 'function') return false;
    let tty;
    try {
      tty = await mux.paneTty(pane);
    } catch {
      return false;
    }
    if (!tty) return false;
    try {
      return !!(await writeTty(tty, '\x07'));
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}
