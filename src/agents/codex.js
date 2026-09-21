// OpenAI Codex CLI adapter.
//
// Codex has no hook that fires on usage limits (its `notify` config only emits
// agent-turn-complete), so detection is scrape-only. The TUI does NOT exit on
// a hard limit — it renders one red transcript line and sits at the composer:
//   ■ You've hit your usage limit. …{ or try again at 3:51 PM.}
// Reset-time tails vary by plan: "try again at 3:51 PM." (same day),
// "try again at Feb 23rd, 2026 9:01 PM." (cross-day), "Try again in 4 days
// 20 hours 9 minutes." (older builds), or "Try again later." (no timestamp).
// Transient errors render "stream error: … retrying 4/5 in 1.4s" and must take
// the overload path, never the ledger.

import { openSync, readSync, closeSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { CODEX_DIR } from '../config.js';
import { findOnPath } from '../which.js';

// Since the 2026 unified ChatGPT desktop app absorbed the Codex app, the codex
// binary ships INSIDE the app bundle and many machines have no standalone
// `codex` on PATH at all — yet ~/.codex/sessions rollouts (and the resume
// command) work identically through the bundled binary (verified live against
// codex-cli 0.144 from ChatGPT.app).
export const CHATGPT_CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex';

// Windows keeps the Desktop/Store install's CLI under a versioned runtime
// directory — %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe — whose name
// changes on every update. The interactive shell finds it through a PATH the
// app rewrote; a daemon started at logon keeps the PATH it was born with,
// which after an update names a directory that no longer exists (#25). So
// look the directory up at launch time and take the newest runtime, the way
// CHATGPT_CODEX_BIN covers the macOS bundle. Layout as reported by the
// issue's Microsoft Store install; a machine without it just gets null.
export function windowsBundledCodex({ env = process.env, readdir = readdirSync, stat = statSync } = {}) {
  if (!env.LOCALAPPDATA) return null;
  const base = join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  let entries;
  try { entries = readdir(base, { withFileTypes: true }); } catch { return null; }
  let best = null;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const exe = join(base, e.name, 'codex.exe');
    let mtime;
    try { mtime = stat(exe).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime) best = { exe, mtime };
  }
  return best ? best.exe : null;
}

// What to spawn for codex. Order, on Windows: an explicit UNSNOOZE_CODEX_BIN,
// a codex.exe on PATH (spawn resolves the bare name itself), the newest
// Desktop/Store runtime, then a .cmd/.bat shim on PATH by full path — Node
// refuses to spawn those without a shell, and a full path makes the launcher's
// error say which file it was. Elsewhere: PATH, then the macOS app bundle.
export function resolveCodexBin({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  onPath = null,
  bundled = () => windowsBundledCodex({ env }),
} = {}) {
  if (env.UNSNOOZE_CODEX_BIN) return env.UNSNOOZE_CODEX_BIN;
  if (platform === 'win32') {
    if (findOnPath(['codex.exe'], { env, exists, platform })) return 'codex';
    const runtime = bundled();
    if (runtime) return runtime;
    const shim = findOnPath(['codex.cmd', 'codex.bat'], { env, exists, platform });
    if (shim) return shim.path;
    return 'codex';
  }
  const found = onPath ? onPath() : !!findOnPath(['codex'], { env, exists, platform });
  if (found) return 'codex';
  if (exists(CHATGPT_CODEX_BIN)) return CHATGPT_CODEX_BIN;
  return 'codex';   // neither — the launcher degrades gracefully on spawn error
}

const LIMIT_ANCHORS = [
  /You've hit your usage limit/i,
  /Your workspace is out of credits/i,
  /hit your spend cap/i,
];

export const patterns = {
  limitPatterns: LIMIT_ANCHORS,
  // The whole banner is ONE line, so the anchors double as reset lines — the
  // proximity engine then hands that line to time-parser (which falls back to
  // the 5h default for "Try again later.").
  resetPatterns: [
    /try again at/i,
    /try again in \d+/i,
    /try again later/i,
    ...LIMIT_ANCHORS,
  ],
  weeklyPatterns: [/weekly limit/i],
  fiveHourPatterns: [/5h limit/i],
  busyPatterns: [
    /esc to interrupt/i,           // "• Working (12s • esc to interrupt)"
    /retrying\s+\d+\/\d+/i,        // internal stream-error retry — don't inject
  ],
  idleRegex: /›/,                  // composer: "› Ask Codex to do anything"
  overloadPatterns: [/stream error/i, /exceeded retry limit/i],
  transientPatterns: [/stream error/i, /exceeded retry limit/i],
};

// Sessions live in ~/.codex/sessions/YYYY/MM/DD/rollout-{ts}-{UUID}.jsonl;
// the first JSONL line carries the session cwd. Conservative: no cwd match →
// null (the resumer then uses `codex resume --last`, which codex itself scopes
// to the launch cwd).
export const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// The thread uuid a rollout path names, or null for anything else. Cheaper than
// rolloutMeta() (no read) and the same id in every rollout seen so far.
export function rolloutId(path) {
  if (typeof path !== 'string') return null;
  const m = basename(path).match(ROLLOUT_RE);
  return m ? m[1].toLowerCase() : null;
}

function fileHead(path, bytes = 4096) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString('utf-8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function latestSessionId(cwd, aroundTs = null, sessionsRoot = join(CODEX_DIR, 'sessions')) {
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) { walk(p, depth + 1); continue; }
      const m = e.isFile() && e.name.match(ROLLOUT_RE);
      if (!m) continue;
      let mtime;
      try { mtime = statSync(p).mtimeMs; } catch { continue; }
      if (aroundTs != null && Math.abs(mtime - aroundTs) > 30 * 60_000) continue;
      files.push({ path: p, id: m[1], mtime });
    }
  };
  walk(sessionsRoot, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  // JSON-escape the cwd the way it appears inside the meta line.
  const needle = cwd ? JSON.stringify(cwd).slice(1, -1) : null;
  for (const f of files.slice(0, 20)) {
    if (!needle || fileHead(f.path).includes(needle)) return f.id;
  }
  return null;
}

export default {
  id: 'codex',
  name: 'OpenAI Codex CLI',
  bin: resolveCodexBin(),
  experimental: false,
  patterns,
  menu: null,                      // no interactive limit menu
  // What to do about a workspace wall (credits depleted, a spend cap): no
  // window reset clears it, so the resumer's ceiling notification names this.
  // Not `unsnooze resume-now`: the hold leaves the record failed, and
  // resume-now only wakes stopped ones — it would answer "no matching stopped
  // sessions" to the one command the notification told the user to run.
  modelRemedy: 'add credits or raise the spend cap in the ChatGPT workspace (or ask its owner to), then continue the session in Codex',
  // Resume takes the prompt in argv — `codex resume <id> "msg"` starts the turn
  // immediately, nothing to type into the TUI.
  //
  // canType: false (headless — no pane): the TUI cannot run there at all. It
  // refuses a non-TTY stdin before it looks at the session ("Error: stdin is
  // not a terminal", exit 1 — reproduced against codex-cli 0.150 with the
  // headless backend's exact stdio), so `codex exec resume <id> "msg"` carries
  // the same conversation forward non-interactively instead (#25). With
  // --last, codex reads a lone positional as the prompt, not a session id.
  //
  // `exec` also refuses any directory that is not a git repository unless
  // told --skip-git-repo-check ("Not inside a trusted directory…", exit 1),
  // a guard the TUI never had: without the flag, a session that ran in a
  // plain folder could never be revived headless. It is the user's own
  // session, resumed where it already ran, so the flag goes on.
  //
  // extraArgsAt: resumeExtraArgs go right after `exec`, not at the end. The
  // `resume` subcommand rejects -s/--sandbox, -p/--profile and --add-dir
  // ("unexpected argument", exit 2) — exactly what a user sets to match
  // their normal launch — while `exec` takes them. (TUI-only flags such as
  // -a or --search have no exec equivalent and still fail, visibly.)
  resumeArgs(sessionId, message, { canType = true } = {}) {
    const tail = sessionId ? [sessionId, message] : ['--last', message];
    if (canType) return { args: ['resume', ...tail], messageViaPane: false };
    return {
      args: ['exec', '--skip-git-repo-check', 'resume', ...tail],
      messageViaPane: false,
      extraArgsAt: 1,
    };
  },
  // v1: every agent launches the bare TUI and gets the prompt typed once idle.
  launchArgs(message) { return { args: [], messageViaPane: true }; },
  latestSessionId,
  isForegroundCommand(cmd) {
    return cmd === 'codex' || cmd === 'node' || cmd === 'unsnooze';
  },
};
