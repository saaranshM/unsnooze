import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { promisify } from 'node:util';

import { resolveSessionName, SessionCreateError } from './session-name.js';
import { ownsSession, recordOwnedSession } from '../mux-sessions.js';

const execFileAsync = promisify(execFileCb);

// windowsHide: the console-less monitor polls through the async path every few
// seconds (see workspace.js). The sync new-session needs the real console.
function defaultSpawner(file, args, { sync = false, ...options } = {}) {
  if (sync) return spawnSync(file, args, options);
  return execFileAsync(file, args, { windowsHide: true, ...options }).then(({ stdout }) => stdout);
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

// tmux on native Windows is psmux, and three of its differences break revival
// (verified against psmux 3.3.6, which reports itself as "tmux 3.3.6"):
//  - Command words are joined with spaces and run through pwsh/cmd unless `--`
//    precedes them, and only new-session honours `--` — new-window always goes
//    through the shell. `C:\Program Files\nodejs\node.exe` then dies at
//    "C:\Program" and the window closes before the agent ever starts.
//  - Pane ids are per session: every session's first pane is %1, and a bare
//    `-t %1` means whichever session is newest. `session:%1` is exact.
//  - A target pane that is gone resolves to some other pane: send-keys exits 0
//    and types into it, capture-pane reads it.
// Real tmux accepts `--` and `session:%N` too, so an MSYS2 tmux is unharmed.

// This pane's id as unsnooze addresses it: `session:%N` inside psmux, which
// exports PSMUX_SESSION; the bare server-global %N under real tmux.
export function tmuxPaneFromEnv(env = process.env) {
  if (!env.TMUX_PANE) return null;
  return env.PSMUX_SESSION ? `${env.PSMUX_SESSION}:${env.TMUX_PANE}` : env.TMUX_PANE;
}

export function createTmux({ spawner = defaultSpawner, env = process.env, platform = process.platform,
  ownsSessionFn = ownsSession, recordSessionFn = recordOwnedSession,
} = {}) {
  const run = (...args) => spawner('tmux', args);
  const psmux = platform === 'win32';
  const PANE_FMT = psmux ? '#{session_name}:#{pane_id}' : '#{pane_id}';
  const RAW = psmux ? ['--'] : [];
  // A pane-targeted command, refused for a pane that is gone — real tmux does
  // that itself; psmux would run it against another pane.
  const onPane = async (pane, cmd, ...args) => {
    if (psmux && !(await backend.paneAlive(pane))) throw new Error(`can't find pane: ${pane}`);
    return run(cmd, '-t', pane, ...args);
  };
  const sessionTaken = name => {
    try {
      return spawner('tmux', ['has-session', '-t', name], { sync: true, stdio: 'ignore', env }).status === 0;
    } catch {
      return false;
    }
  };

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
      return tmuxPaneFromEnv(env);
    },

    // Called inside the wrapper, before the interactive agent starts. Mouse
    // mode makes the wheel enter tmux scrollback for regular-screen CLIs,
    // instead of terminal alternate-scroll translating it into Up/Down keys.
    // Only sessions we created get a default; explicit session settings and
    // borrowed tmux sessions retain the user's choices. Never set -g or replace
    // wheel bindings: mouse-aware apps must still receive their mouse events.
    configureManagedPane(pane) {
      try {
        const info = spawner('tmux', ['display-message', '-t', pane, '-p', '#{session_id}\t#{session_name}'],
          { sync: true, encoding: 'utf8' });
        if (info.status !== 0) return false;
        const [id, ...parts] = String(info.stdout || '').trim().split('\t');
        const name = parts.join('\t');
        if (!/^\$\d+$/.test(id) || !name || !ownsSessionFn('tmux', name)) return false;
        const current = spawner('tmux', ['show-options', '-qv', '-t', id, 'mouse'],
          { sync: true, encoding: 'utf8' });
        if (current.status !== 0 || String(current.stdout || '').trim()) return false;
        return spawner('tmux', ['set-option', '-t', id, 'mouse', 'on'],
          { sync: true, stdio: 'ignore' }).status === 0;
      } catch { return false; } // optional UX; never prevent an agent launch
    },

    async capturePane(pane, lines = 200) {
      return onPane(pane, 'capture-pane', '-p', '-S', `-${lines}`);
    },

    async capturePaneVisible(pane) {
      return onPane(pane, 'capture-pane', '-p');
    },

    async paneInMode(pane) {
      try { return (await onPane(pane, 'display-message', '-p', '#{pane_in_mode}')).trim() === '1'; }
      catch { return true; } // uncertain input destination: defer a wake
    },

    async sendText(pane, text) {
      await onPane(pane, 'send-keys', '-l', text);
      await new Promise(resolve => setTimeout(resolve, SUBMIT_DELAY_MS));
      await onPane(pane, 'send-keys', 'Enter');
    },

    async sendKey(pane, key) {
      await onPane(pane, 'send-keys', key);
    },

    async paneAlive(pane) {
      try {
        // tmux 3.7b prints a blank line and exits 0 for a nonexistent target,
        // and psmux names a different pane, so the exit code alone is not
        // evidence — the output must echo the pane id back.
        const out = await run('display-message', '-t', pane, '-p', PANE_FMT);
        return out.trim() === pane;
      } catch {
        return false;
      }
    },

    // Live session the pane currently lives in. Trust stdout, not the exit
    // code (same tmux 3.7b blank-success pitfall as paneAlive).
    async sessionForPane(pane) {
      try {
        const out = (await onPane(pane, 'display-message', '-p', '#{session_name}')).trim();
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
        const out = (await onPane(pane, 'display-message', '-p', '#{pane_tty}')).trim();
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
        return (await onPane(pane, 'display-message', '-p', '#{pane_current_command}')).trim();
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
        await onPane(pane, 'set-option', '-p', '@unsnooze_owner', String(leaseId));
        return true;
      } catch {
        return false;
      }
    },

    // Read the stamp back. Blank (unset option / missing pane) and errors are
    // both null — trust stdout, not the exit code (tmux 3.7b blank-success).
    async paneOwnerStamp(pane) {
      try {
        const out = (await onPane(pane, 'display-message', '-p', '#{@unsnooze_owner}')).trim();
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
        const out = await run('list-panes', '-t', sessionName, '-F', PANE_FMT);
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
      const launch = [...envArgs(launchSpec.env), ...RAW, launchSpec.file, ...(launchSpec.args || [])];
      // psmux: new-window would run the command through a shell, so each
      // revival opens its own session — resumer and prompt-queue persist it.
      if (psmux) {
        const session = resolveSessionName(sessionName, sessionTaken);
        recordSessionFn({ mux: 'tmux', name: session });
        const pane = await run('new-session', '-d', '-s', session, '-c', cwd,
          '-P', '-F', PANE_FMT, ...launch);
        return { pane: pane.trim(), paneOwner: null, session };
      }
      let pane;
      if (!(await backend.sessionExists(sessionName))) {
        recordSessionFn({ mux: 'tmux', name: sessionName });
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
      const name = resolveSessionName(wrappedSessionName(env), sessionTaken);
      launchSpec.onSessionCreated?.(name);
      // Session name is discovered live via sessionForPane at record-write
      // time — do NOT inject UNSNOOZE_SESSION_NAME (would leak into daemons
      // spawned from the agent via {...process.env}).
      const args = ['new-session', '-s', name,
        ...envArgs(launchSpec.env), ...RAW, launchSpec.file, ...(launchSpec.args || [])];
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
