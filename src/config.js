import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  mkdirSync, chmodSync, writeFileSync, renameSync, lstatSync, statSync, readdirSync,
} from 'node:fs';

function envInt(name, def) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}

export const STATE_DIR = process.env.UNSNOOZE_STATE_DIR || join(homedir(), '.unsnooze');
export const STATE_FILE = join(STATE_DIR, 'state.json');
export const LOCK_DIR = join(STATE_DIR, 'state.lock');
export const LOG_FILE = join(STATE_DIR, 'unsnooze.log');
export const EVENTS_DIR = join(STATE_DIR, 'events');
export const RESUMER_LOCK = join(STATE_DIR, 'resumer.lock');
// High-frequency burn accumulator + warn-dedup (daemon single-writer).
export const USAGE_FILE = join(STATE_DIR, 'usage.json');

// Everything under STATE_DIR is owner-only. The directory holds an ntfy
// bearer token (config.json), queued prompt text and cwd paths (state.json),
// ssh destinations and credential-source commands (hosts.json) — none of it
// another local user's business, and the dir mode is what protects the files
// that don't set their own. mkdir's `mode` only applies when it creates, so
// a 0755 dir left by a pre-1.17.0 install is repaired explicitly.
// No-op on Windows (node's chmod only carries the read-only bit there); the
// user profile ACL already restricts it.
export function ensureStateDir(dir = STATE_DIR) {
  // Creating a directory owner-only is always right — we are about to put a
  // 0600 file in it.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Narrowing one that ALREADY exists is only ever done for our own state
  // dir. ensureStateDir is also called with a caller-supplied path
  // (writeUsageStore takes one), and re-permissioning someone else's
  // directory — or the files inside it — is not this function's business.
  if (isStateDir(dir)) {
    try { chmodSync(dir, 0o700); } catch { /* shared/CI dir, not ours to fix */ }
    repairModes(dir);
  }
  return dir;
}

// Repairing an install that predates 1.17.0. Three things the writers alone
// cannot fix: mkdir's `mode` is ignored for a directory that already exists,
// an append/open reuses an existing file's inode, and config.json/hosts.json
// are written only by `config set` / `hosts add` — on an install that never
// touches them again they would keep their old 0644 (and, for config.json,
// the ntfy token in it) indefinitely. So the modes are repaired directly.
//
// Re-checked on an interval rather than once per process: daemon.log is
// created by launchd/systemd redirecting the daemon's stdout, so it can
// appear at 0644 AFTER a pass has run — in a process that then lives for
// days. A walk is a readdir and a handful of lstats, so this is free at
// daemon cadence.
const MODE_REPAIR_INTERVAL_MS = envInt('UNSNOOZE_MODE_REPAIR_MS', 60_000);
const repairedAt = new Map();

// Compare resolved paths, not raw strings: callers reach ensureStateDir
// through dirname(join(STATE_DIR, 'config.json')), which normalizes away a
// trailing slash that STATE_DIR itself may carry from UNSNOOZE_STATE_DIR. A
// raw comparison silently answers "not our directory" and skips the repair.
const isStateDir = (dir) => resolve(dir) === resolve(STATE_DIR);

// ONE walk, exported so `unsnooze doctor` reports from exactly what the
// automatic repair acts on. They were separate before, and drifted: the
// repair worked from a fixed list of filenames while doctor walked the whole
// directory, so a quarantined state.json or a crashed writer's tmp file — the
// two leftovers that hold verbatim copies of the sensitive files — were
// reported forever and never fixed.
//
// Top level plus one level down is the entire layout: a handful of files and
// four flat subdirectories.
export function scanStateDir(dir = STATE_DIR, { platform = process.platform } = {}) {
  const out = [];
  // Windows has no POSIX mode bits. libuv synthesises them by mirroring the
  // owner bits into group and other (win/fs.c `fs__stat_impl`), so a file is
  // always 0666 (0444 read-only) and a directory 0777 — `mode & 0o077` is
  // never zero and EVERY entry would look permanently exposed. Meanwhile
  // uv_fs_chmod only toggles FILE_ATTRIBUTE_READONLY, so no repair could ever
  // clear it: doctor would never report healthy, `--fix` would claim success
  // while changing nothing, and the daemon would re-chmod the whole directory
  // every interval forever. Access there is governed by the profile ACL.
  if (platform === 'win32') return out;
  // The root is stat'd, not lstat'd: a state dir that is itself a symlink is
  // a legitimate setup (dotfiles, another volume) and must still be checked
  // and repaired. Entries INSIDE are lstat'd and a link is skipped — chmod
  // follows links, and following one there would reach outside the dir.
  const inspect = (path, rel, isRoot = false) => {
    try {
      const st = isRoot ? statSync(path) : lstatSync(path);
      if (!isRoot && st.isSymbolicLink()) return null;
      const linked = !isRoot && !st.isDirectory() && st.nlink > 1;
      // Strip group/other, but never the owner's execute bit: the state dir
      // holds executables (askpass.sh, and whatever a test or a user drops
      // beside it), and forcing a flat 0600 turns those into EACCES on spawn.
      // Directories need their own traverse bit, hence 0700 rather than 0600.
      const want = st.isDirectory() ? 0o700 : (0o600 | (st.mode & 0o100));
      if ((st.mode & 0o077) !== 0) {
        // `skipRepair` for a hardlink: lstat cannot distinguish one, so chmod
        // would change an inode that also lives outside this directory.
        // Reported anyway — an exposed file the repair will not touch is
        // exactly what the doctor finding exists to surface.
        out.push({ path, rel, mode: st.mode & 0o777, want, skipRepair: linked });
      }
      return st;
    } catch { return null; }
  };
  if (!inspect(dir, '.', true)) return out;
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const path = join(dir, name);
    const st = inspect(path, name);
    if (!st?.isDirectory()) continue;
    try {
      for (const child of readdirSync(path)) inspect(join(path, child), `${name}/${child}`);
    } catch { /* unreadable */ }
  }
  return out;
}

// Applies what scanStateDir found. `want` carries 0700 for directories and
// 0600 for files — a directory chmod'd 0600 would lose its traverse bit and
// nothing inside it could be opened.
// Returns { fixed, refused, ineffective }. The three outcomes are genuinely
// different and the caller needs to tell them apart:
//   fixed       — the bits moved.
//   refused     — chmod threw (EPERM, EROFS, an immutable flag). A real
//                 exposure that cannot be repaired; keep reporting it.
//   ineffective — chmod SUCCEEDED and nothing changed. The filesystem does
//                 not implement POSIX modes at all (a CIFS/vfat/NTFS mount
//                 with `noperm`, WSL's drvfs, a Docker bind mount from a
//                 Windows host). Retrying forever would never converge, and
//                 `process.platform` does not identify this case — only
//                 attempting it does.
export function narrowStateDir(entries) {
  let fixed = 0, refused = 0, ineffective = 0;
  for (const e of entries) {
    if (e.skipRepair) continue;
    try {
      chmodSync(e.path, e.want);
      if ((lstatSync(e.path).mode & 0o077) === 0) fixed += 1;
      else ineffective += 1;
    } catch { refused += 1; }
  }
  return { fixed, refused, ineffective };
}

// Directories whose filesystem provably ignores chmod. Learned by attempting
// it, never guessed from the platform.
const modesUnenforced = new Set();

function repairModes(dir) {
  // Key on the resolved path: callers reach this through
  // dirname(join(STATE_DIR, 'x')), which normalizes a trailing slash away, so
  // raw strings would give the same directory two throttle slots.
  const key = resolve(dir);
  if (modesUnenforced.has(key)) return;
  const now = Date.now();
  if (now - (repairedAt.get(key) ?? -Infinity) < MODE_REPAIR_INTERVAL_MS) return;
  repairedAt.set(key, now);
  const entries = scanStateDir(dir);
  if (entries.length === 0) return;
  const { fixed, refused, ineffective } = narrowStateDir(entries);
  // Every attempt succeeded and not one bit moved: this filesystem has no
  // POSIX modes to set. Stop walking it — the alternative is re-chmodding
  // the whole directory every interval for the life of the daemon.
  if (fixed === 0 && refused === 0 && ineffective > 0) modesUnenforced.add(key);
}

// tmp + rename + chmod. writeFileSync's `mode` lands only when it CREATES the
// file, so a tmp left behind by a crashed predecessor that happened to share
// this pid would otherwise carry its own 0644 onto the target through the
// rename — and a target left 0644 by an older version would never be fixed.
// The chmod after the rename closes both. Same pattern, and the same reason,
// as ensureAskpassHelper in askpass.js.
export function writePrivateFile(target, tmp, data) {
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, target);
  // A filesystem with no usable chmod (FAT, some network mounts) must not
  // turn every state write into a crash — the 0700 directory still covers it.
  try { chmodSync(target, 0o600); } catch { /* best-effort */ }
  return target;
}

export const CLAUDE_DIR = process.env.UNSNOOZE_CLAUDE_DIR
  || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
export const CLAUDE_SETTINGS = join(CLAUDE_DIR, 'settings.json');
export const CODEX_DIR = process.env.UNSNOOZE_CODEX_DIR || join(homedir(), '.codex');
// Opt-in statusline shim drop dir for exact Claude rate_limits.
export const USAGE_STATUSLINE_DIR = join(CLAUDE_DIR, 'unsnooze');

// Transcript/rollout watcher (GUI detection channel)
export const WATCH_OFFSETS_FILE = join(STATE_DIR, 'watch-offsets.json');

// Usage forecast (1.13)
export const USAGE_BURN_LOOKBACK_MS = envInt('UNSNOOZE_USAGE_BURN_LOOKBACK_MS', 60 * 60_000);
export const USAGE_BURN_MIN_COVERAGE_MS = envInt('UNSNOOZE_USAGE_BURN_MIN_MS', 10 * 60_000);
export const USAGE_IDLE_GAP_MS = envInt('UNSNOOZE_USAGE_IDLE_GAP_MS', 5 * 60_000);
export const USAGE_WINDOW_IDLE_MS = envInt('UNSNOOZE_USAGE_WINDOW_IDLE_MS', 5 * 3_600_000);
export const USAGE_CALIBRATION_RING = envInt('UNSNOOZE_USAGE_CAL_RING', 20);
export const USAGE_CALIBRATION_MEDIAN_N = envInt('UNSNOOZE_USAGE_CAL_N', 5);
// Time-to-wall warn tiers (minutes); comma-separated, not a config-file key.
export const USAGE_ETA_WARN_MIN = (process.env.UNSNOOZE_USAGE_ETA_WARN_MIN || '30,10')
  .split(',').map(Number).filter(n => Number.isFinite(n) && n > 0);

// Interactive launcher base session name. The daemon never CREATES this name
// (see RESUME_SESSION_NAME); it may only join it when already live.
export const MUX_SESSION_NAME = process.env.UNSNOOZE_SESSION_NAME
  || process.env.UNSNOOZE_TMUX_SESSION || 'unsnooze';
// Legacy alias — older docs/scripts and any external importers used this name.
export const TMUX_SESSION_NAME = MUX_SESSION_NAME;

// Session the daemon creates for revivals when the pane's original session is
// gone. Must never collide with the interactive base name.
export const RESUME_SESSION_NAME = process.env.UNSNOOZE_RESUME_SESSION
  || `${MUX_SESSION_NAME}-resumed`;

// Timing (ms unless noted)
export const RESET_MARGIN_MS = envInt('UNSNOOZE_RESET_MARGIN_MS', 60_000);
export const POLL_INTERVAL_MS = envInt('UNSNOOZE_POLL_INTERVAL_MS', 30_000);       // resumer epoch polling
export const SCRAPE_INTERVAL_MS = envInt('UNSNOOZE_SCRAPE_INTERVAL_MS', 5_000);    // monitor pane scraping
export const FALLBACK_RESET_MS = envInt('UNSNOOZE_FALLBACK_RESET_MS', 5 * 3_600_000);
// When no reset time parses: cheap pane probes instead of sleeping for 5h.
// Backoff 15 → 30 → 60 min (capped at PROBE_MAX_MS); hard ceiling remains
// FALLBACK_RESET_MS from detectedAt.
export const PROBE_INTERVAL_MS = envInt('UNSNOOZE_PROBE_INTERVAL_MS', 15 * 60_000);
export const PROBE_MAX_MS = envInt('UNSNOOZE_PROBE_MAX_MS', 60 * 60_000);
export const STAGGER_MS = envInt('UNSNOOZE_STAGGER_MS', 8_000);
export const VERIFY_DELAY_MS = envInt('UNSNOOZE_VERIFY_DELAY_MS', 20_000);
export const BUSY_DEFER_MS = envInt('UNSNOOZE_BUSY_DEFER_MS', 60_000);
export const READY_TIMEOUT_MS = envInt('UNSNOOZE_READY_TIMEOUT_MS', 60_000);
export const EVENT_MARKER_TTL_MS = envInt('UNSNOOZE_EVENT_MARKER_TTL_MS', 120_000);
export const WATCH_FRESHNESS_MS = envInt('UNSNOOZE_WATCH_FRESHNESS_MS', 15 * 60_000);

// How long a monitor waits for its agent's lease to appear before concluding
// the launch failed and exiting. The launcher writes the lease immediately
// after spawn(), so this only ever elapses when no agent was started at all.
export const LEASE_GRACE_MS = envInt('UNSNOOZE_LEASE_GRACE_MS', 60_000);

// Multiplexer backends, in detection order. The single source of truth: the
// factory, the `multiplexer` setting enum and reap's session sweep all read
// this list. It lives here, in a module that imports nothing but node builtins,
// because settings.js and multiplexer.js already import each other — declaring
// it in either one puts the other in a temporal dead zone at import time.
// cmux is last: an agent can run tmux inside a cmux surface, so tmux/zellij
// must win detection when both are signalled (see multiplexer.js: detect()).
// headless is last of all and never auto-detected from the environment: it is
// the no-multiplexer fallback (native Windows, servers, CI), and a real pane
// must always beat it.
export const MUX_NAMES = ['tmux', 'zellij', 'herdr', 'cmux', 'headless'];

// Where a headless revive tees the agent's output. There is no pane to scroll
// back through, so the log is the only record of what an unattended run did.
export const HEADLESS_LOG_DIR = join(STATE_DIR, 'headless');

// Pane scanning
export const PANE_SCAN_LINES = envInt('UNSNOOZE_PANE_SCAN_LINES', 12);
export const CAPTURE_LINES = envInt('UNSNOOZE_CAPTURE_LINES', 200);

// Limits & retries
export const MAX_RESUME_ATTEMPTS = envInt('UNSNOOZE_MAX_RESUME_ATTEMPTS', 5);
export const MAX_BUSY_DEFERS = envInt('UNSNOOZE_MAX_BUSY_DEFERS', 10);
export const OVERLOAD_BACKOFF_S = (process.env.UNSNOOZE_OVERLOAD_BACKOFF_S || '30,60,120,240,300')
  .split(',').map(Number).filter(Number.isFinite);
export const OVERLOAD_JITTER = 0.15;
export const DEDUPE_WINDOW_MS = envInt('UNSNOOZE_DEDUPE_WINDOW_MS', 120_000);
export const PRUNE_AFTER_MS = envInt('UNSNOOZE_PRUNE_AFTER_MS', 7 * 86_400_000);
// Non-terminal records with a dead/absent pane older than this are marked
// failed instead of being revived forever (ghost-pane multiplier).
export const STALE_AFTER_MS = envInt('UNSNOOZE_STALE_AFTER_MS', 7 * 86_400_000);
export const STALE_LOCK_MS = envInt('UNSNOOZE_STALE_LOCK_MS', 10_000);
