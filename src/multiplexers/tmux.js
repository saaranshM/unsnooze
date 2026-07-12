import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { promisify } from 'node:util';

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

    async paneCurrentCommand(pane) {
      try {
        return (await run('display-message', '-t', pane, '-p', '#{pane_current_command}')).trim();
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
      return { pane: pane.trim(), paneOwner: sessionName };
    },

    launchWrapped(launchSpec) {
      // A foreground, single-pane session disappears with the agent. Keeping
      // tmux in the foreground also gives Ctrl-C to the active pane directly.
      // Its -e environment flags require tmux >= 3.2; older versions fail
      // revival with an "unknown flag -e" error.
      const args = ['new-session', '-s', wrappedSessionName(env),
        ...envArgs(launchSpec.env), launchSpec.file, ...(launchSpec.args || [])];
      const result = spawner('tmux', args, { sync: true, stdio: 'inherit', env });
      return exitStatus(result);
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
