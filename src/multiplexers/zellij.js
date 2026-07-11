import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

function defaultSpawner(file, args, { sync = false, ...options } = {}) {
  if (sync) return spawnSync(file, args, options);
  return execFileAsync(file, args, options).then(({ stdout }) => stdout);
}

function scrubZellijEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('ZELLIJ')));
}

function launchArgv({ file, args = [], env = {} }) {
  const assignments = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  return ['/usr/bin/env', ...assignments, file, ...args];
}

function exitStatus(result) {
  if (result.status !== null && result.status !== undefined) return result.status;
  return result.signal ? 128 + (osConstants.signals[result.signal] || 0) : 1;
}

function wrappedSessionName(env) {
  return env.UNSNOOZE_SESSION_NAME || env.UNSNOOZE_TMUX_SESSION || 'unsnooze';
}

function rawKeyBytes(key) {
  const known = {
    Escape: [27], Enter: [13], Tab: [9], Backspace: [127],
    Down: [27, 91, 66], Up: [27, 91, 65],
    Right: [27, 91, 67], Left: [27, 91, 68],
  };
  return known[key] || [...Buffer.from(key)];
}

function kdlString(value) {
  return JSON.stringify(String(value));
}

function wrappedLayout(launchSpec) {
  const argv = launchArgv(launchSpec);
  return `layout { pane command=${kdlString(argv[0])} close_on_exit=true { args ${argv.slice(1).map(kdlString).join(' ')} } }`;
}

export const SUBMIT_DELAY_MS = 150;

export function createZellij({ spawner = defaultSpawner, env = process.env } = {}) {
  const childEnv = () => scrubZellijEnv(env);
  const run = (args, options = {}) => spawner('zellij', args, { env: childEnv(), ...options });

  const build = owner => {
    const owned = (...args) => {
      if (!owner) throw new Error('unsnooze: zellij pane operation requires a session owner');
      return run(['-s', owner, ...args]);
    };

    const paneEntries = async () => {
      const stdout = await owned('action', 'list-panes', '-a', '-j');
      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed : [];
    };

    const backend = {
      name: 'zellij',
      owner,
      SUBMIT_DELAY_MS,

      available() {
        try {
          return spawner('zellij', ['--version'], { sync: true, stdio: 'ignore', env: childEnv() }).status === 0;
        } catch {
          return false;
        }
      },

      inside() { return !!env.ZELLIJ; },
      currentPaneId() {
        if (env.UNSNOOZE_MUX === 'zellij' && env.UNSNOOZE_PANE) return env.UNSNOOZE_PANE;
        return env.ZELLIJ_PANE_ID || null;
      },

      async capturePane(pane) {
        return owned('action', 'dump-screen', '--pane-id', String(pane));
      },

      async capturePaneVisible(pane) {
        return owned('action', 'dump-screen', '--pane-id', String(pane));
      },

      async sendText(pane, text) {
        await owned('action', 'write-chars', '--pane-id', String(pane), text);
        await new Promise(resolve => setTimeout(resolve, SUBMIT_DELAY_MS));
        await owned('action', 'write', '--pane-id', String(pane), '13');
      },

      async sendKey(pane, key) {
        if (key === 'Down' || key === 'Up') {
          try {
            await owned('action', 'send-keys', '--pane-id', String(pane), key);
            return;
          } catch {
            // Older/changed zellij key grammars still have a raw-byte path.
          }
        } else if (key === 'Enter') {
          await owned('action', 'write', '--pane-id', String(pane), '13');
          return;
        }
        await owned('action', 'write', '--pane-id', String(pane), ...rawKeyBytes(key).map(String));
      },

      async paneAlive(pane) {
        try {
          const id = Number(pane);
          return (await paneEntries()).some(entry =>
            entry.id === id && entry.is_plugin === false && entry.exited === false);
        } catch {
          return false;
        }
      },

      async paneCurrentCommand(pane) {
        try {
          const id = Number(pane);
          const entry = (await paneEntries()).find(candidate =>
            candidate.id === id && candidate.is_plugin === false && candidate.exited === false);
          return entry?.pane_command ? basename(entry.pane_command) : null;
        } catch {
          return null;
        }
      },

      async sessionExists(name) {
        try {
          const stdout = await run(['list-sessions', '-s']);
          return stdout.split(/\r?\n/).some(line => line.trim() === name);
        } catch {
          return false;
        }
      },

      async newWindow(sessionName, cwd, launchSpec) {
        if (!(await backend.sessionExists(sessionName))) {
          await run(['attach', '-b', '-c', sessionName]);
        }
        const stdout = await run([
          '-s', sessionName, 'run', '--cwd', cwd, '--', ...launchArgv(launchSpec),
        ]);
        const match = stdout.trim().match(/^terminal_(\d+)$/);
        if (!match) throw new Error(`unsnooze: unexpected zellij pane id: ${stdout.trim()}`);
        return { pane: match[1], paneOwner: sessionName };
      },

      launchWrapped(launchSpec) {
        // The layout contains exactly one auto-closing pane, avoiding the
        // lingering default shell created by attach -b. The foreground client
        // owns the terminal, so Ctrl-C reaches zellij and its active pane.
        const result = spawner('zellij', [
          '--session', wrappedSessionName(env), '--layout-string', wrappedLayout(launchSpec),
        ], {
          sync: true, stdio: 'inherit', env: childEnv(),
        });
        return exitStatus(result);
      },

      bind(nextOwner) { return build(nextOwner); },
    };

    return backend;
  };

  return build(null);
}

const zellij = createZellij();

export const available = (...args) => zellij.available(...args);
export const inside = (...args) => zellij.inside(...args);
export const currentPaneId = (...args) => zellij.currentPaneId(...args);
export const launchWrapped = (...args) => zellij.launchWrapped(...args);

export default zellij;
