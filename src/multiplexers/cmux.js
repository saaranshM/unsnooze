import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

import { SessionCreateError } from './session-name.js';

const execFileAsync = promisify(execFileCb);

function defaultSpawner(file, args, { sync = false, ...options } = {}) {
  if (sync) return spawnSync(file, args, options);
  return execFileAsync(file, args, options).then(({ stdout }) => stdout);
}

export const SUBMIT_DELAY_MS = 150;

export { SessionCreateError };

// cmux's `send-key` takes a small lowercase key vocabulary (enter, tab,
// escape, backspace, delete, up, down, left, right); unsnooze only ever asks
// for these three capitalized, tmux-style names, so translate them.
const KEY_NAMES = { Enter: 'enter', Up: 'up', Down: 'down' };

// `--command` is typed into the new workspace's real shell as a literal
// keystroke line (cmux has no argv-exec launch path like tmux/zellij), so the
// wrapped file+args must be assembled into valid, single-quoted shell syntax.
function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function argvLine(launchSpec) {
  return [launchSpec.file, ...(launchSpec.args || [])].map(shQuote).join(' ');
}

function envArgs(env = {}) {
  return Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .flatMap(([key, value]) => ['--env', `${key}=${value}`]);
}

export function createCmux({ spawner = defaultSpawner, env = process.env } = {}) {
  const run = (...args) => spawner('cmux', args);

  const backend = {
    name: 'cmux',
    SUBMIT_DELAY_MS,

    // Unlike tmux/zellij, where the binary IS the server (a missing session
    // just gets started on demand), cmux's binary is a thin socket client:
    // `--version` only proves the CLI is on PATH, not that the cmux app is
    // running. A cmux that's installed but not open still passes this check,
    // then fails every real operation with a socket connection error. That's
    // an accepted gap here — every socket call already degrades gracefully
    // (paneAlive/capturePane return false/throw, launchWrapped/newWindow
    // throw and get caught upstream) — but it does mean this signal alone
    // can't tell "not installed" apart from "installed, not running" for
    // status/setup messaging (doctor.js, wizard.js) the way it can for
    // tmux/zellij.
    available() {
      try {
        return spawner('cmux', ['--version'], { sync: true, stdio: 'ignore' }).status === 0;
      } catch {
        return false;
      }
    },

    inside() { return !!env.CMUX_SOCKET_PATH; },
    currentPaneId() {
      if (env.UNSNOOZE_MUX === 'cmux' && env.UNSNOOZE_PANE) return env.UNSNOOZE_PANE;
      return env.CMUX_SURFACE_ID || null;
    },

    async capturePane(pane, lines = 200) {
      return run('read-screen', '--surface', pane, '--scrollback', '--lines', String(lines));
    },

    async capturePaneVisible(pane) {
      return run('read-screen', '--surface', pane);
    },

    async sendText(pane, text) {
      await run('send', '--surface', pane, '--', text);
      await new Promise(resolve => setTimeout(resolve, SUBMIT_DELAY_MS));
      await run('send-key', '--surface', pane, 'enter');
    },

    async sendKey(pane, key) {
      await run('send-key', '--surface', pane, KEY_NAMES[key] || String(key).toLowerCase());
    },

    // cmux's v2 socket returns an explicit `not_found` error (non-zero exit)
    // for a missing surface — verified against a live cmux instance — unlike
    // tmux 3.7b's blank-line/exit-0 quirk for a stale target. A thrown read
    // is therefore trustworthy evidence the surface is gone.
    async paneAlive(pane) {
      try {
        await run('read-screen', '--surface', pane);
        return true;
      } catch {
        return false;
      }
    },

    // cmux has no tmux/zellij-style joinable named session: every revival
    // opens a fresh workspace (cmux's window/tab unit) and types the wrapped
    // command into its default shell. `workspace create --json` echoes the
    // new default surface's ref directly, so no follow-up lookup is needed.
    async newWindow(sessionName, cwd, launchSpec) {
      const out = await run('--json', 'workspace', 'create',
        '--name', sessionName, '--cwd', cwd, '--command', argvLine(launchSpec),
        ...envArgs(launchSpec.env));
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        throw new Error(`unsnooze: unexpected cmux workspace create output: ${String(out).slice(0, 200)}`);
      }
      const pane = parsed.surface_ref || parsed.surface_id;
      if (!pane) throw new Error('unsnooze: cmux workspace create returned no surface');
      return { pane, paneOwner: null };
    },

    // cmux is a native GUI terminal the agent is expected to already be
    // running inside (that's the premise this driver detects), not something
    // launched fresh and attached to synchronously from a plain shell the way
    // tmux/zellij are — there is no session to wrap into from outside it.
    launchWrapped() {
      throw new SessionCreateError(
        'cmux sessions cannot be started from outside cmux — open a workspace in cmux and run the command there');
    },

    async closePane(pane) {
      await run('close-surface', '--surface', pane);
    },

    // Surface ids are cmux-global handles, not scoped to an owning session
    // (like tmux pane ids), so owner binding is inert.
    bind() { return backend; },
  };

  return backend;
}

const cmux = createCmux();

export const available = (...args) => cmux.available(...args);
export const inside = (...args) => cmux.inside(...args);
export const currentPaneId = (...args) => cmux.currentPaneId(...args);
export const capturePane = (...args) => cmux.capturePane(...args);
export const capturePaneVisible = (...args) => cmux.capturePaneVisible(...args);
export const sendText = (...args) => cmux.sendText(...args);
export const sendKey = (...args) => cmux.sendKey(...args);
export const paneAlive = (...args) => cmux.paneAlive(...args);
export const newWindow = (...args) => cmux.newWindow(...args);
export const launchWrapped = (...args) => cmux.launchWrapped(...args);

export default cmux;
