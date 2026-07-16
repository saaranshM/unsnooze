import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { promisify } from 'node:util';

import { resolveSessionName, SessionCreateError } from './session-name.js';

const execFileAsync = promisify(execFileCb);

function defaultSpawner(file, args, { sync = false, ...options } = {}) {
  if (sync) return spawnSync(file, args, options);
  return execFileAsync(file, args, options).then(({ stdout }) => stdout);
}

function envArgs(env = {}) {
  return Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .flatMap(([key, value]) => ['-e', `${key}=${value}`]);
}

function exitStatus(result) {
  if (result.status !== null && result.status !== undefined) return result.status;
  return result.signal ? 128 + (osConstants.signals[result.signal] || 0) : 1;
}

function wrappedSessionName(env) {
  return env.UNSNOOZE_SESSION_NAME || env.UNSNOOZE_TMUX_SESSION || 'unsnooze';
}

// Submit delay: text and the submitting Enter must be TWO separate send-keys
// calls with a pause between them, or Ink treats Enter as bracketed paste.
export const SUBMIT_DELAY_MS = 150;

// tmux stderr signatures that mean the wrapped session never started (vs the
// session running and ending). Only these may trigger the unwatched fallback —
// anything broader risks double-running an agent that already ran. All of
// these are printed by the tmux client BEFORE the inner command executes
// (name collision, tty/socket problems, nesting refusal, fatal startup).
const SESSION_START_ERROR_RE = new RegExp([
  'duplicate session',
  'open terminal failed',
  'error connecting',
  'server exited unexpectedly',
  'no server running',
  'create session failed',
  'sessions should be nested',
  'not a terminal',
  'permission denied',
  "couldn'?t create",
  '^fatal:',
].join('|'), 'im');

export { SessionCreateError };

export function createTmux({ spawner = defaultSpawner, env = process.env } = {}) {
  const run = (...args) => spawner('tmux', args);

  const backend = {
    name: 'tmux',
    SUBMIT_DELAY_MS,

    available() {
      try {
        return spawner('tmux', ['-V'], { sync: true, stdio: 'ignore' }).status === 0;
      } catch {
        return false;
      }
    },

    inside() { return !!env.TMUX; },
    currentPaneId() {
      if (env.UNSNOOZE_MUX === 'tmux' && env.UNSNOOZE_PANE) return env.UNSNOOZE_PANE;
      return env.TMUX_PANE || null;
    },

    async capturePane(pane, lines = 200) {
      return run('capture-pane', '-t', pane, '-p', '-S', `-${lines}`);
    },

    async capturePaneVisible(pane) {
      return run('capture-pane', '-t', pane, '-p');
    },

    async sendText(pane, text) {
      await run('send-keys', '-t', pane, '-l', text);
      await new Promise(resolve => setTimeout(resolve, SUBMIT_DELAY_MS));
      await run('send-keys', '-t', pane, 'Enter');
    },

    async sendKey(pane, key) {
      await run('send-keys', '-t', pane, key);
    },

    async paneAlive(pane) {
      try {
        // tmux 3.7b prints a blank line and exits 0 for a nonexistent target,
        // so the exit code alone is not evidence — the output must echo the
        // pane id back.
        const out = await run('display-message', '-t', pane, '-p', '#{pane_id}');
        return out.trim() === pane;
      } catch {
        return false;
      }
    },

    // Live session the pane currently lives in. Trust stdout, not the exit
    // code (same tmux 3.7b blank-success pitfall as paneAlive).
    async sessionForPane(pane) {
      try {
        const out = (await run('display-message', '-t', pane, '-p', '#{session_name}')).trim();
        return out || null;
      } catch {
        return null;
      }
    },

    // Clients attached to the session that owns `pane`. Detached / missing
    // targets return [] so callers can feature-detect without try/catch.
    async clientTtys(pane) {
      try {
        const out = await run('list-clients', '-t', pane, '-F', '#{client_tty}\t#{client_termname}');
        return out.split('\n')
          .map(line => line.trimEnd())
          .filter(Boolean)
          .map(line => {
            const [tty, termname = ''] = line.split('\t');
            return { tty, termname };
          })
          .filter(entry => entry.tty);
      } catch {
        return [];
      }
    },

    async paneTty(pane) {
      try {
        const out = (await run('display-message', '-t', pane, '-p', '#{pane_tty}')).trim();
        return out || null;
      } catch {
        return null;
      }
    },

    // Global session env from `show-environment -g`. `-REMOVED` markers are
    // skipped; only keys listed in `names` are returned. Errors → {}.
    async globalEnv(names = []) {
      if (!names.length) return {};
      try {
        const out = await run('show-environment', '-g');
        const wanted = new Set(names);
        const result = {};
        for (const line of out.split('\n')) {
          const trimmed = line.trimEnd();
          // tmux prints "NAME=value" or "NAME -REMOVED"
          if (!trimmed || trimmed.endsWith(' -REMOVED')) continue;
          const eq = trimmed.indexOf('=');
          if (eq <= 0) continue;
          const key = trimmed.slice(0, eq);
          if (!wanted.has(key)) continue;
          result[key] = trimmed.slice(eq + 1);
        }
        return result;
      } catch {
        return {};
      }
    },

    async paneCurrentCommand(pane) {
      try {
        return (await run('display-message', '-t', pane, '-p', '#{pane_current_command}')).trim();
      } catch {
        return null;
      }
    },

    // Ownership stamp: a pane user option written at creation. It survives
    // the agent process exiting but dies with the pane, so a recycled pane id
    // never carries a stale stamp. Requires tmux >= 3.0 (-p pane options) —
    // older tmux fails quietly and callers fall back to lease checks.
    async stampPaneOwner(pane, leaseId) {
      try {
        await run('set-option', '-p', '-t', pane, '@unsnooze_owner', String(leaseId));
        return true;
      } catch {
        return false;
      }
    },

    // Read the stamp back. Blank (unset option / missing pane) and errors are
    // both null — trust stdout, not the exit code (tmux 3.7b blank-success).
    async paneOwnerStamp(pane) {
      try {
        const out = (await run('display-message', '-t', pane, '-p', '#{@unsnooze_owner}')).trim();
        return out || null;
      } catch {
        return null;
      }
    },

    async sessionExists(name) {
      try {
        await run('has-session', '-t', name);
        return true;
      } catch {
        return false;
      }
    },

    async listSessions() {
      try {
        const out = await run('list-sessions', '-F', '#{session_name}');
        return out.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
          .map(name => ({ name, exited: false }));
      } catch {
        return [];
      }
    },

    async listSessionPanes(sessionName) {
      try {
        const out = await run('list-panes', '-t', sessionName, '-F', '#{pane_id}');
        return out.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      } catch {
        return [];
      }
    },

    async closePane(pane) {
      await run('kill-pane', '-t', pane);
    },

    async deleteSession(name) {
      await run('kill-session', '-t', name);
    },

    async newWindow(sessionName, cwd, launchSpec) {
      // Environment flags require tmux >= 3.0 for new-window and >= 3.2 for
      // new-session. Older tmux fails revival with an "unknown flag -e" error.
      const launch = [...envArgs(launchSpec.env), launchSpec.file, ...(launchSpec.args || [])];
      let pane;
      if (!(await backend.sessionExists(sessionName))) {
        pane = await run('new-session', '-d', '-s', sessionName, '-c', cwd,
          '-P', '-F', '#{pane_id}', ...launch);
      } else {
        pane = await run('new-window', '-t', `${sessionName}:`, '-c', cwd,
          '-P', '-F', '#{pane_id}', ...launch);
      }
      // tmux pane ids are server-global; paneOwner is only meaningful for
      // zellij. Tracking the session lives on muxSession, not paneOwner.
      return { pane: pane.trim(), paneOwner: null };
    },

    launchWrapped(launchSpec) {
      // A foreground, single-pane session disappears with the agent. Keeping
      // tmux in the foreground also gives Ctrl-C to the active pane directly.
      // Its -e environment flags require tmux >= 3.2; older versions fail
      // revival with an "unknown flag -e" error.
      const name = resolveSessionName(wrappedSessionName(env), candidate => {
        try {
          return spawner('tmux', ['has-session', '-t', candidate],
            { sync: true, stdio: 'ignore', env }).status === 0;
        } catch {
          return false;
        }
      });
      // Session name is discovered live via sessionForPane at record-write
      // time — do NOT inject UNSNOOZE_SESSION_NAME (would leak into daemons
      // spawned from the agent via {...process.env}).
      const args = ['new-session', '-s', name,
        ...envArgs(launchSpec.env), launchSpec.file, ...(launchSpec.args || [])];
      // stderr is piped, not inherited: the tmux client draws its UI on the
      // stdin/stdout tty; stderr carries only tmux's own error messages, and
      // capturing them is how a session-start failure is told apart from the
      // session simply ending (tmux exits non-zero for both us and the shell).
      const result = spawner('tmux', args,
        { sync: true, stdio: ['inherit', 'inherit', 'pipe'], env });
      if (result?.error) {
        throw new SessionCreateError(
          `failed to start tmux session "${name}": ${result.error.message}`,
          result.error,
        );
      }
      const status = exitStatus(result);
      const stderr = result?.stderr == null ? '' : String(result.stderr);
      if (status !== 0 && SESSION_START_ERROR_RE.test(stderr)) {
        // The session never ran the agent — safe (and required) to fall back
        // to an unwatched launch without any double-run risk.
        throw new SessionCreateError(
          `tmux could not start session "${name}": ${stderr.trim()}`);
      }
      // Any other tmux chatter stays visible — it was headed for the user's
      // terminal before we piped it.
      if (stderr.trim()) process.stderr.write(stderr);
      return status;
    },

    // tmux pane ids are server-global, so owner binding is intentionally inert.
    bind() { return backend; },
  };

  return backend;
}

const tmux = createTmux();

export const available = (...args) => tmux.available(...args);
export const tmuxAvailable = available;
export const inside = (...args) => tmux.inside(...args);
export const insideTmux = inside;
export const currentPaneId = (...args) => tmux.currentPaneId(...args);
export const capturePane = (...args) => tmux.capturePane(...args);
export const capturePaneVisible = (...args) => tmux.capturePaneVisible(...args);
export const sendText = (...args) => tmux.sendText(...args);
export const sendKey = (...args) => tmux.sendKey(...args);
export const paneAlive = (...args) => tmux.paneAlive(...args);
export const paneCurrentCommand = (...args) => tmux.paneCurrentCommand(...args);
export const sessionExists = (...args) => tmux.sessionExists(...args);
export const newWindow = (...args) => tmux.newWindow(...args);
export const launchWrapped = (...args) => tmux.launchWrapped(...args);

export default tmux;
