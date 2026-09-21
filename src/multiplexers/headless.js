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
import {
  mkdirSync, openSync, closeSync, readSync, statSync, readFileSync, writeFileSync,
  renameSync, unlinkSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';

import { HEADLESS_LOG_DIR } from '../config.js';

export const SUBMIT_DELAY_MS = 0;   // nothing is ever typed

const PID_PREFIX = 'pid:';

// How long a recorded exit stays on disk. A revival is verified ~20s after
// launch and retried within the hour; a day covers a daemon that was asleep.
const EXIT_TTL_MS = 24 * 3_600_000;
// Enough of the child's own output to say why it died, never the whole log.
const EXIT_OUTPUT_BYTES = 4096;

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
  const exitsDir = join(logDir, 'exits');
  const exitPath = pid => join(exitsDir, `${pid}.json`);

  function writeExit(pid, record) {
    try {
      mkdirSync(exitsDir, { recursive: true, mode: 0o700 });
      const tmp = join(exitsDir, `.${pid}.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
      renameSync(tmp, exitPath(pid));
    } catch { /* evidence only — a revival must never fail on bookkeeping */ }
  }

  function readExit(pid) {
    try {
      const parsed = JSON.parse(readFileSync(exitPath(pid), 'utf-8'));
      return parsed && typeof parsed === 'object' && parsed.pid === pid ? parsed : null;
    } catch {
      return null;
    }
  }

  function pruneExits(now = Date.now()) {
    let names;
    try { names = readdirSync(exitsDir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(exitsDir, name);
      try {
        if (now - statSync(path).mtimeMs > EXIT_TTL_MS) unlinkSync(path);
      } catch { /* raced or gone */ }
    }
  }

  // The last lines the child wrote to the shared log, read between the offsets
  // recorded at its launch and at its exit. The upper bound matters: the
  // resumer staggers revivals 8s apart and verifies 20s later, so a revival
  // that died at once is read back after the next one has written its own
  // lines into the same log. (One running alongside it can still interleave.)
  function childOutput(exit) {
    if (!exit.log || !Number.isFinite(exit.from)) return null;
    let fd;
    try {
      const { size } = statSync(exit.log);
      const end = Number.isFinite(exit.to) ? Math.min(exit.to, size) : size;
      const start = Math.max(exit.from, end - EXIT_OUTPUT_BYTES);
      if (end <= start) return null;
      fd = openSync(exit.log, 'r');
      const buf = Buffer.alloc(end - start);
      const n = readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf-8', 0, n).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      return lines.length ? lines.slice(-3).join(' | ') : null;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

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
    //
    // The child's exit is recorded next to that log (exits/<pid>.json). With no
    // pane to capture, an empty capture proves nothing — verifyOne used to read
    // it as a cleared banner and mark a launcher that had died with `spawn
    // codex ENOENT` as resumed (#25). The exit record, plus the slice of the
    // log the child wrote, is what paneOutcome() answers with instead.
    async newWindow(sessionName, cwd, launchSpec) {
      // 0700/0600: this log is the entire stdout+stderr of an unattended
      // agent run — the most revealing thing under the state dir.
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      const logPath = join(logDir, `${sessionName}.log`);
      const fd = openSync(logPath, 'a', 0o600);
      // The log is shared by every revival into this session name, so remember
      // where this child's output starts.
      let from = 0;
      try { from = statSync(logPath).size; } catch { /* just created */ }
      // The child gets this process's environment — the one backend that
      // passes it through. A resumer spawned by the StopFailure hook runs in
      // claude's, which carries UNSNOOZE_ACTIVE=1: the launcher's "nested
      // call, pass straight through" marker. A revival is a fresh top-level
      // launch; with the marker it dropped launchExtraArgs and, on a spawn
      // failure, exited 1 without saying why.
      const childEnv = { ...env, ...launchSpec.env };
      delete childEnv.UNSNOOZE_ACTIVE;
      let child;
      try {
        child = spawner(launchSpec.file, launchSpec.args || [], {
          cwd,
          detached: true,
          stdio: ['ignore', fd, fd],
          env: childEnv,
          windowsHide: true,
        });
      } finally {
        // The child has its own copy; the daemon's would otherwise stay open
        // for the life of the process, one descriptor per revival.
        try { closeSync(fd); } catch { /* already closed */ }
      }
      const pid = child?.pid;
      const startedAt = Date.now();
      let spawnError = null;
      // Listen before anything below can throw. A spawn that fails — the
      // session's cwd was a worktree that has since been deleted, say — says
      // so with an 'error' event after spawn() has returned, and an 'error'
      // nobody listens for is an uncaught exception: the daemon dies with it.
      if (typeof child?.on === 'function') {
        const record = (code, signal, error) => {
          if (!pid) return;
          // Where this child's output ends in the shared log (childOutput).
          let to = null;
          try { to = statSync(logPath).size; } catch { /* gone */ }
          writeExit(pid, {
            pid, code, signal: signal ?? null, error: error ?? null,
            startedAt, at: Date.now(), log: logPath, from, to,
          });
        };
        child.on('exit', (code, signal) => record(code, signal, null));
        child.on('error', err => {
          spawnError = err;
          record(null, null, err?.message || String(err));
        });
      }
      if (typeof child?.unref === 'function') child.unref();
      if (!pid) {
        // The reason arrives on the next tick; wait for it so the record's
        // lastError says why, not just that there was no pid.
        await new Promise(resolve => setImmediate(resolve));
        throw new Error(`unsnooze: headless launch of ${launchSpec.file} produced no pid`
          + (spawnError ? ` (${spawnError.message})` : ''));
      }
      // A recycled pid must not inherit an old exit. Best-effort, like the
      // pruning: an exit record is evidence, never something a launch needs.
      // (No event can have fired yet — nothing above has yielded since spawn.)
      try { unlinkSync(exitPath(pid)); } catch { /* none */ }
      pruneExits();
      return { pane: `${PID_PREFIX}${pid}`, paneOwner: null, session: sessionName };
    },

    // What became of a revival: { exited: false } while it runs, and once it is
    // gone { exited: true, code, signal, output } from the recorded exit, where
    // output is the tail of what the child itself wrote. null when the process
    // is gone and nothing was recorded (a resumer that was not the parent) —
    // the caller then knows exactly as much as it did before.
    async paneOutcome(pane) {
      const pid = parsePidAddress(pane);
      if (pid === null) return null;
      // The record first: newWindow clears any old one for this pid at spawn,
      // so a record here is our child's exit — even if the pid has since been
      // handed to another process (Windows recycles them quickly), which a
      // liveness check alone would read as our revival still running.
      const exit = readExit(pid);
      if (!exit) return alive(pid) ? { exited: false } : null;
      return {
        exited: true,
        code: exit.code ?? null,
        signal: exit.signal ?? null,
        error: exit.error ?? null,
        output: childOutput(exit),
      };
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
