// Update notifications. npm can't push updates, so the CLI nudges:
//   - user-facing commands print a one-line notice (from CACHE only — the
//     registry fetch happens in a detached `_update-check`, never inline)
//   - the daemon fires ONE desktop toast per new version
//   - after the user updates, the next command shows "what's new" straight
//     from the CHANGELOG.md bundled in the npm tarball (zero network)
// All of it is gated on the `updateCheck` setting / UNSNOOZE_UPDATE_CHECK.
// The check is a plain GET to registry.npmjs.org — nothing identifying.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from './settings.js';
import { notify } from './notify.js';
import { UNSNOOZE_BIN, pidAlive } from './spawn.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

const CACHE_FILE = () => join(process.env.UNSNOOZE_STATE_DIR || join(process.env.HOME || '', '.unsnooze'), 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 3_600_000;
const RELEASES_URL = 'https://github.com/saaranshM/unsnooze/releases';

export function readCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE(), 'utf-8')); } catch { return {}; }
}

export function writeCache(patch) {
  const merged = { ...readCache(), ...patch };
  const path = CACHE_FILE();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.update-check.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n');
  renameSync(tmp, path);
  return merged;
}

// Plain x.y.z compare. We never publish prereleases; anything that isn't
// three numbers loses (a garbage registry response must never nag).
export function isNewer(candidate, current) {
  const parse = v => (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)) ? v.split('.').map(Number) : null;
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function isCacheStale(now = Date.now()) {
  return now - (readCache().lastCheckedAt || 0) > CHECK_INTERVAL_MS;
}

// Version-skew guard for long-lived processes: after `npm i -g` swaps the
// package out underneath a running daemon, the loaded code (PKG_VERSION,
// read at module load) no longer matches the on-disk package.json. The
// daemon exits cleanly on skew so launchd/systemd restart it on fresh code —
// never again a zombie daemon running deleted code.
//
// A missing/unreadable/garbage package.json is NOT skew: mid-upgrade the file
// may briefly not exist, and exiting then would race the installer. Only a
// readable, *different* version is proof the upgrade finished.
export function hasVersionSkew({ root = ROOT, current = PKG_VERSION } = {}) {
  try {
    const disk = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;
    return typeof disk === 'string' && /^\d+\.\d+\.\d+$/.test(disk) && disk !== current;
  } catch {
    return false;
  }
}

// Skew hand-off for long-lived processes that have NO supervisor: per-pane
// monitors (spawned once by the launcher, alive as long as the agent) and
// transient resumers (alive until resetAt — routinely hours). The daemon can
// simply exit on skew because launchd/systemd bring it back; these cannot, so
// they must spawn their own replacement on the fresh code and only then stand
// down. Without this a pane launched before an upgrade keeps deciding with the
// code it loaded at launch — how 1.14.2's stop-completion fix reached disk on
// a user's host without ever reaching the process that makes the decision.
//
// Returns true only when a replacement is confirmed spawned; the caller stands
// down on true and keeps running on false. A failed spawn must never take the
// old process with it — a stale watcher beats no watcher.
export async function restartOnVersionSkew({
  args, env = {}, spawner, skewed = hasVersionSkew, log = () => {},
  binPath = UNSNOOZE_BIN, beforeSpawn = null,
  confirmDelayMs = 400, alive = pidAlive, sleep = defaultSleep,
} = {}) {
  if (!skewed()) return false;
  // Pre-flight. `npm i -g` can be observed mid-swap: a new, readable
  // package.json over a tree whose bin/ has not landed yet. Spawning into that
  // hands off to nothing, so treat it as "not ready" and try again next tick.
  if (!existsSync(binPath)) {
    log(`version skew detected but ${binPath} is missing (upgrade in flight) — continuing on old code`);
    return false;
  }
  // Only now may the caller give anything up (the resumer releases its
  // singleton here) — never for a hand-off that was already impossible.
  beforeSpawn?.();
  let pid = null;
  try {
    pid = spawner(args, env);
  } catch (err) {
    log(`version skew detected but respawn failed (${err.message}) — continuing on old code`);
    return false;
  }
  if (!Number.isFinite(pid) || pid <= 0) {
    log('version skew detected but respawn returned no pid — continuing on old code');
    return false;
  }
  // Post-flight. A pid is not proof of a running replacement: spawn() resolves
  // the NODE BINARY, which exists no matter what, so a missing or broken script
  // still returns a pid and fires no 'error' event — the child is simply dead
  // by the time we look. Confirm it survived startup before standing down.
  await sleep(confirmDelayMs);
  if (!alive(pid)) {
    log(`version skew: replacement pid ${pid} died on startup — continuing on old code`);
    return false;
  }
  log(`version skew: package replaced on disk — handed off to pid ${pid}, exiting`);
  return true;
}

// What a daemon should do when it notices the package changed underneath it.
// Supervised (launchd/systemd): exit — the supervisor brings it back on fresh
// code, which is why the unit files use KeepAlive / Restart=always. Anything
// else — `unsnooze daemon` run straight from a shell — has nothing to restart
// it, so exiting would silently end GUI watching. There it keeps running on
// the old code and says so, once: the same "stale beats none" trade the
// monitor makes. Kept as a pure decision so the policy is testable without
// standing up a daemon.
export function daemonSkewAction({ skewed, supervised, alreadyWarned = false } = {}) {
  if (!skewed) return 'none';
  if (supervised) return 'restart';
  return alreadyWarned ? 'none' : 'warn';
}

export async function fetchLatest({ fetcher = globalThis.fetch, timeoutMs = 3000 } = {}) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetcher('https://registry.npmjs.org/unsnooze/latest', {
        signal: ctrl.signal, headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      const body = await res.json();
      return typeof body?.version === 'string' ? body.version : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;   // offline, timeout, bad JSON — never the CLI's problem
  }
}

// Cache-only, instant. Printed to stderr after user-facing commands.
export function updateNotice(pkgVersion = PKG_VERSION) {
  if (!getConfig('updateCheck')) return null;
  const { latest } = readCache();
  if (!latest || !isNewer(latest, pkgVersion)) return null;
  return `unsnooze ${latest} is available (you have ${pkgVersion}) — run: unsnooze update · ${RELEASES_URL}`;
}

// Post-session-exit notice for the agent-launch path (the update-notifier
// pattern: non-blocking, from cache, AFTER the run — never a pre-launch
// prompt, which the tmux alt-screen would wipe anyway). Wrapper-only users
// never run `unsnooze status`, so the moment the agent exits and the screen
// is restored is the one moment a notice reliably reaches them. Throttled to
// once per day via lastNoticeAt; stamps only when it actually fires.
const NOTICE_INTERVAL_MS = 24 * 3_600_000;

export function launchExitNotice({ now = Date.now(), pkgVersion = PKG_VERSION } = {}) {
  const notice = updateNotice(pkgVersion);
  if (!notice) return null;
  if (now - (readCache().lastNoticeAt || 0) < NOTICE_INTERVAL_MS) return null;
  writeCache({ lastNoticeAt: now });
  return notice;
}

// The "## <version>" block from the CHANGELOG.md that ships in the tarball.
export function changelogSection(version, maxLines = 6) {
  try {
    const lines = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf-8').split('\n');
    const start = lines.findIndex(l => l.startsWith(`## ${version}`));
    if (start === -1) return null;
    const rest = lines.slice(start + 1);
    const end = rest.findIndex(l => l.startsWith('## '));
    const section = rest.slice(0, end === -1 ? undefined : end)
      .filter(l => l.trim() !== '')
      .slice(0, maxLines);
    return section.length ? section.join('\n') : null;
  } catch {
    return null;
  }
}

// Once after an update: "you're now on X, here's what changed."
export function whatsNewNotice(pkgVersion = PKG_VERSION) {
  if (!getConfig('updateCheck')) return null;
  const { lastRunVersion } = readCache();
  if (lastRunVersion === pkgVersion) return null;
  writeCache({ lastRunVersion: pkgVersion });
  if (!lastRunVersion) return null;   // first ever run — nothing to announce
  const section = changelogSection(pkgVersion);
  return `Updated to ${pkgVersion}.` + (section ? ` What's new:\n${section}` : ` ${RELEASES_URL}/tag/v${pkgVersion}`);
}

// The detached `_update-check`: fetch, cache, toast once per new version.
export async function runUpdateCheck({ fetcher, notifier = notify, now = Date.now() } = {}) {
  if (!getConfig('updateCheck')) return 0;
  const latest = await fetchLatest({ fetcher });
  if (!latest) return 0;
  const cache = writeCache({ lastCheckedAt: now, latest });
  if (isNewer(latest, PKG_VERSION) && cache.notifiedVersion !== latest) {
    notifier('unsnooze update available', `${latest} is out (you have ${PKG_VERSION}) — run: unsnooze update`);
    writeCache({ notifiedVersion: latest });
  }
  return 0;
}

// `unsnooze update` — self-update via npm, then show what changed. npm -g
// overwrites this install in place, so re-reading package.json/CHANGELOG.md
// after a successful install yields the NEW version's info.
export function runSelfUpdate({ runner = spawnSync, print = console.log } = {}) {
  print(`unsnooze ${PKG_VERSION} — updating via npm install -g unsnooze@latest …`);
  const r = runner('npm', ['install', '-g', 'unsnooze@latest'], { stdio: 'inherit' });
  if (r.error || r.status !== 0) {
    print(`unsnooze: update failed (${r.error ? r.error.message : `npm exited ${r.status}`}).`);
    print('unsnooze: try it manually: npm install -g unsnooze@latest');
    print('unsnooze: (permission errors usually mean your npm prefix needs sudo or a user-writable prefix)');
    return r.status || 1;
  }
  let newVersion = PKG_VERSION;
  try {
    newVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;
  } catch { /* moved install dir — the generic message below still holds */ }
  if (newVersion === PKG_VERSION) {
    print(`unsnooze: already up to date (${PKG_VERSION}).`);
  } else {
    const section = changelogSection(newVersion);
    print(`unsnooze: updated to ${newVersion}.${section ? ` What's new:\n${section}` : ''}`);
  }
  // Don't repeat "what's new" on the next command.
  writeCache({ lastRunVersion: newVersion });
  return 0;
}
