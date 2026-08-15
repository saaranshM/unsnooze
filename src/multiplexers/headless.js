// Headless backend: watching without a multiplexer.
//
// tmux, Zellij, herdr and cmux are all Unix terminal multiplexers, which left
// native Windows (and bare servers, and CI) with nothing to watch — the
// launcher printed "run inside WSL" and ran the agent unwatched. But a pane is
// only one of unsnooze's three detection channels; the StopFailure hook
// (src/hook.js) and the transcript watcher (src/watchers/claude.js) are both
// OS-agnostic and need no pane at all. This backend supplies the missing half:
// somewhere to put a revived agent.
//
// The deliberate shape of it:
//   - capturePane() is empty, so the ownership triad in resumer.assessPane()
//     can never reach `authorized` and no revive can ever try to *type*. Every
//     headless revive therefore takes the reopen() path, which carries its
//     prompt in argv (claude accepts `--resume <id> "<prompt>"`).
//   - a "pane" is a pid. That is the whole address space.
//   - there is no session registry, so listSessions() is absent and reap's
//     session sweep skips headless rather than claiming to own anything.

import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

import { HEADLESS_LOG_DIR } from '../config.js';

export const SUBMIT_DELAY_MS = 0;   // nothing is ever typed

const PID_PREFIX = 'pid:';

export function parsePidAddress(pane) {
  if (typeof pane !== 'string' || !pane.startsWith(PID_PREFIX)) return null;
  const pid = Number.parseInt(pane.slice(PID_PREFIX.length), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function defaultSpawner(file, args, options) {
  return spawn(file, args, options);
}

function defaultKill(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

function defaultAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else. That is not
    // ours to drive, so treat it as gone rather than as a live agent.
    return err.code === 'EPERM' ? false : false;
  }
}

export function createHeadless({
  spawner = defaultSpawner,
  kill = defaultKill,
  alive = defaultAlive,
  logDir = HEADLESS_LOG_DIR,
  env = process.env,
  platform = process.platform,
} = {}) {
  const backend = {
    name: 'headless',
    SUBMIT_DELAY_MS,

    // Built in — there is no binary to look for and nothing to install. This
    // is what makes the launcher's "no multiplexer, run unwatched" dead end
    // unreachable on platforms that have no multiplexer to install.
    available() { return true; },

    // There is no session to be inside or outside of, so the launcher always
    // takes its in-session branch and never tries to wrap itself into one.
    inside() { return true; },

    // null on purpose: src/launcher.js reads a missing pane id as "launch the
    // agent, skip the monitor". A monitor would poll capturePane(), which
    // headless answers with '' forever — a watcher that can never see anything.
    // The hook and the transcript watcher do the seeing instead.
    currentPaneId() { return null; },

    // Empty, not an error: assessPane() calls this on every dispatch and must
    // get a string back. Empty content fails the triad's content test, which
    // is precisely the guarantee that keeps sendText() unreachable.
    async capturePane() { return ''; },
    async capturePaneVisible() { return ''; },

    async sendText() {
      throw new Error('unsnooze: headless sessions have no pane to type into — '
        + 'the resume prompt must travel in argv');
    },
    async sendKey() {
      throw new Error('unsnooze: headless sessions have no pane to send keys to');
    },

    // A revive is just a detached child. Its output goes to a per-session log
    // because there is no scrollback to read it out of later.
    async newWindow(sessionName, cwd, launchSpec) {
      mkdirSync(logDir, { recursive: true });
      const logPath = join(logDir, `${sessionName}.log`);
      const fd = openSync(logPath, 'a');
      const child = spawner(launchSpec.file, launchSpec.args || [], {
        cwd,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: { ...env, ...launchSpec.env },
        windowsHide: true,
      });
      if (typeof child?.unref === 'function') child.unref();
      if (!child?.pid) {
        throw new Error(`unsnooze: headless launch of ${launchSpec.file} produced no pid`);
      }
      return { pane: `${PID_PREFIX}${child.pid}`, paneOwner: null, session: sessionName };
    },

    // Nothing to wrap into: the user's own terminal is the session. Returning
    // null tells the launcher to carry on and run the agent in place, where the
    // hook and transcript watcher will see any limit stop.
    launchWrapped() { return null; },

    async paneAlive(pane) {
      const pid = parsePidAddress(pane);
      return pid === null ? false : alive(pid);
    },

    async paneCurrentCommand() { return null; },   // liveness comes from the lease

    async closePane(pane) {
      const pid = parsePidAddress(pane);
      if (pid !== null) kill(pid);
    },

    // No owner scoping: a pid is machine-global.
    bind() { return backend; },

    // Deliberately absent: listSessions, listSessionPanes, sessionExists,
    // deleteSession, stampPaneOwner, paneOwnerStamp, clientTtys, paneTty.
    // reap.listOwnedSessions() skips a backend without listSessions, and
    // identity falls back to the lease (src/lease.js) without a pane stamp.
    // Adding no-op versions would make headless *claim* ownership it cannot
    // prove, which is exactly what reap is written to refuse.
  };

  // Reserved for a future native-console revive on Windows; unused today but
  // kept so callers can branch without sniffing process.platform themselves.
  backend.platform = platform;

  return backend;
}

const headless = createHeadless();

export const available = (...args) => headless.available(...args);
export const inside = (...args) => headless.inside(...args);
export const currentPaneId = (...args) => headless.currentPaneId(...args);
export const capturePane = (...args) => headless.capturePane(...args);
export const capturePaneVisible = (...args) => headless.capturePaneVisible(...args);
export const sendText = (...args) => headless.sendText(...args);
export const sendKey = (...args) => headless.sendKey(...args);
export const paneAlive = (...args) => headless.paneAlive(...args);
export const newWindow = (...args) => headless.newWindow(...args);
export const launchWrapped = (...args) => headless.launchWrapped(...args);

export default headless;
