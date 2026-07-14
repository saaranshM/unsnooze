import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { basename } from 'node:path';
import { promisify } from 'node:util';

import { resolveSessionName, SessionCreateError } from './session-name.js';

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

// Parse `zellij list-sessions -s` rows: strip ANSI, keep leading name token,
// detect an "(EXITED …)" suffix. Rows that fail to parse are dropped.
function parseSessionRows(stdout) {
  return String(stdout)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const name = line.split(/\s+/)[0];
      if (!name) return null;
      return { name, exited: /\(EXITED/i.test(line) };
    })
    .filter(Boolean);
}

export const SUBMIT_DELAY_MS = 150;

export { SessionCreateError };

export function createZellij({ spawner = defaultSpawner, env = process.env } = {}) {
  const childEnv = () => scrubZellijEnv(env);
  const run = (args, options = {}) => spawner('zellij', args, { env: childEnv(), ...options });

  // Sync counterpart of sessionExists, for the sync launchWrapped path. Rows can
  // carry ANSI colour and an "(EXITED …)" suffix, so only the leading name token
  // is compared. Probe failure → empty set: assume free and let zellij arbitrate.
  const liveSessionNames = () => {
    try {
      const result = spawner('zellij', ['list-sessions', '-s'],
        { sync: true, encoding: 'utf8', env: childEnv() });
      const stdout = typeof result === 'string' ? result : (result?.stdout ?? '');
      return new Set(parseSessionRows(stdout).map(row => row.name));
    } catch {
      return new Set();
    }
  };

  const build = owner => {
    const owned = (...args) => {
      if (!owner) throw new Error('unsnooze: zellij pane operation requires a session owner');
      return run(['-s', owner, ...args]);
    };

    const paneEntries = async (session = owner) => {
      if (!session) throw new Error('unsnooze: zellij pane operation requires a session owner');
      const stdout = await run(['-s', session, 'action', 'list-panes', '-a', '-j']);
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

      // v1 limitation: dump-screen is viewport-only, so `lines` is ignored;
      // unlike tmux, a banner/menu that scrolls away between polls is missed.
      // `dump-screen --full` may provide a future scrollback-capable option.
      async capturePane(pane, _lines = 200) {
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

      // Pane ids are per-session; the bound owner is the session name. Fall
      // back to the ambient ZELLIJ_SESSION_NAME when unbound.
      async sessionForPane(_pane) {
        return owner || env.ZELLIJ_SESSION_NAME || null;
      },

      async paneCurrentCommand(pane) {
        try {
          const id = Number(pane);
          const entry = (await paneEntries()).find(candidate =>
            candidate.id === id && candidate.is_plugin === false && candidate.exited === false);
          // zellij's pane_command includes arguments (e.g. "node -e …",
          // "claude --resume <id>"), so take the executable token before basename.
          if (!entry?.pane_command) return null;
          return basename(entry.pane_command.trim().split(/\s+/)[0]);
        } catch {
          return null;
        }
      },

      async sessionExists(name) {
        try {
          const stdout = await run(['list-sessions', '-s']);
          return parseSessionRows(stdout).some(row => row.name === name);
        } catch {
          return false;
        }
      },

      async listSessions() {
        try {
          const stdout = await run(['list-sessions', '-s']);
          return parseSessionRows(stdout);
        } catch {
          return [];
        }
      },

      async listSessionPanes(sessionName) {
        try {
          const entries = await paneEntries(sessionName);
          return entries
            .filter(entry => entry.is_plugin === false && entry.exited === false)
            .map(entry => String(entry.id));
        } catch {
          return [];
        }
      },

      async closePane(pane) {
        if (!owner) throw new Error('unsnooze: zellij pane operation requires a session owner');
        await owned('action', 'close-pane', '-p', `terminal_${pane}`);
      },

      async deleteSession(name) {
        await run(['delete-session', name]);
      },

      async newWindow(sessionName, cwd, launchSpec) {
        let created = false;
        let preexisting = [];
        if (!(await backend.sessionExists(sessionName))) {
          // attach -b -c uses the default layout, which leaves a shell pane
          // that never exits. Snapshot its ids so we can close them after the
          // agent pane is added (closing the last pane would kill the session).
          await run(['attach', '-b', '-c', sessionName]);
          created = true;
          try {
            preexisting = (await paneEntries(sessionName))
              .filter(entry => entry.is_plugin === false)
              .map(entry => entry.id);
          } catch {
            preexisting = [];
          }
        }
        // --close-on-exit matches launchWrapped's close_on_exit=true and tmux
        // (pane dies with its command) so exited revivals don't keep the session.
        const stdout = await run([
          '-s', sessionName, 'run', '--close-on-exit', '--cwd', cwd, '--',
          ...launchArgv(launchSpec),
        ]);
        const match = stdout.trim().match(/^terminal_(\d+)$/);
        if (!match) throw new Error(`unsnooze: unexpected zellij pane id: ${stdout.trim()}`);
        if (created && preexisting.length) {
          for (const id of preexisting) {
            try {
              await run(['-s', sessionName, 'action', 'close-pane', '-p', `terminal_${id}`]);
            } catch {
              // Best-effort: a missing default pane is fine.
            }
          }
        }
        return { pane: match[1], paneOwner: sessionName };
      },

      launchWrapped(launchSpec) {
        // The layout contains exactly one auto-closing pane, avoiding the
        // lingering default shell created by attach -b. The foreground client
        // owns the terminal, so Ctrl-C reaches zellij and its active pane.
        const live = liveSessionNames();
        const name = resolveSessionName(wrappedSessionName(env), c => live.has(c));
        // Session name is discovered live via sessionForPane at record-write
        // time — do NOT inject UNSNOOZE_SESSION_NAME into the layout env.
        const result = spawner('zellij', [
          '--session', name, '--layout-string', wrappedLayout(launchSpec),
        ], {
          sync: true, stdio: 'inherit', env: childEnv(),
        });
        if (result?.error) {
          throw new SessionCreateError(
            `failed to start zellij session "${name}": ${result.error.message}`,
            result.error,
          );
        }
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
