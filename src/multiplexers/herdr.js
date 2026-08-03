// herdr panes have no close-on-exit: when an agent command exits, the pane
// remains alive with its shell prompt. The resumer must therefore verify
// agent ownership before injecting, and revival can reuse a surviving pane
// only when Task 3 wires that path deliberately.
// Launch env is delivered via workspace create --env. Keep this narrow because
// pane run types argv into the pane shell, but preserve the two Claude config
// roots: desktop/isolated Claude sessions cannot be resumed without them.

import { execFile as execFileCb, spawn, spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { basename } from 'node:path';
import { promisify } from 'node:util';

import { resolveSessionName, SessionCreateError } from './session-name.js';

const execFileAsync = promisify(execFileCb);
const MIN_VERSION = [0, 7, 5];
const SERVER_POLL_MS = 50;
const SERVER_POLL_ATTEMPTS = 80;

function defaultSpawner(file, args, { sync = false, detach = false, ...options } = {}) {
  if (detach) {
    const child = spawn(file, args, {
      ...options,
      detached: true,
      stdio: options.stdio ?? 'ignore',
    });
    child.unref();
    return child;
  }
  if (sync) return spawnSync(file, args, options);
  return execFileAsync(file, args, options).then(({ stdout }) => stdout);
}

function scrubHerdrEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('HERDR')));
}

function envFlags(env = {}) {
  return Object.entries(env)
    .filter(([key, value]) => (
      /^UNSNOOZE_/.test(key)
      || key === 'CLAUDE_CONFIG_DIR'
      || key === 'CLAUDE_SECURESTORAGE_CONFIG_DIR'
    ) && value !== undefined)
    .flatMap(([key, value]) => ['--env', `${key}=${value}`]);
}

function exitStatus(result) {
  if (result.status !== null && result.status !== undefined) return result.status;
  return result.signal ? 128 + (osConstants.signals[result.signal] || 0) : 1;
}

function wrappedSessionName(env) {
  return env.UNSNOOZE_SESSION_NAME || env.UNSNOOZE_TMUX_SESSION || 'unsnooze';
}

function parseResult(stdout) {
  const parsed = JSON.parse(String(stdout));
  return (parsed && typeof parsed === 'object' && 'result' in parsed) ? parsed.result : parsed;
}

function parseVersion(stdout) {
  const match = String(stdout).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(actual, floor) {
  for (let index = 0; index < floor.length; index += 1) {
    const value = actual[index] ?? 0;
    if (value !== floor[index]) return value > floor[index];
  }
  return true;
}

const KEY_MAP = {
  Escape: 'esc',
  Enter: 'enter',
  Tab: 'tab',
  Backspace: 'backspace',
  Down: 'down',
  Up: 'up',
  Right: 'right',
  Left: 'left',
};

export const SUBMIT_DELAY_MS = 150;

export { SessionCreateError };

export function createHerdr({ spawner = defaultSpawner, env = process.env } = {}) {
  const childEnv = () => scrubHerdrEnv(env);
  const run = (args, options = {}) => spawner('herdr', args, { env: childEnv(), ...options });

  const parseSessionList = stdout => {
    const result = parseResult(stdout);
    return Array.isArray(result?.sessions) ? result.sessions : [];
  };

  const syncOutput = result => typeof result === 'string' ? result : (result?.stdout ?? '');

  const sleepSync = milliseconds => {
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buffer, 0, 0, milliseconds);
  };

  const build = owner => {
    const owned = (...args) => {
      if (!owner) throw new Error('unsnooze: herdr pane operation requires a session owner');
      return run(['--session', owner, ...args]);
    };
    const inSession = (session, ...args) => {
      if (!session) throw new Error('unsnooze: herdr pane operation requires a session owner');
      return run(['--session', session, ...args]);
    };

    const sessionRunning = async name =>
      (await backend.listSessions()).some(row => row.name === name && !row.exited);

    const ensureSessionRunning = async name => {
      if (await sessionRunning(name)) return;
      let child;
      try {
        child = spawner('herdr', ['--session', name, 'server'], {
          detach: true,
          detached: true,
          stdio: 'ignore',
          env: childEnv(),
        });
      } catch (error) {
        throw new SessionCreateError(
          `failed to start herdr session "${name}": ${error.message}`, error,
        );
      }
      if (child?.error) {
        throw new SessionCreateError(
          `failed to start herdr session "${name}": ${child.error.message}`, child.error,
        );
      }
      for (let attempt = 0; attempt < SERVER_POLL_ATTEMPTS; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, SERVER_POLL_MS));
        if (await sessionRunning(name)) return;
      }
      throw new SessionCreateError(`herdr session "${name}" server did not start`);
    };

    const liveSessionNames = () => {
      try {
        const result = spawner('herdr', ['session', 'list', '--json'], {
          sync: true,
          encoding: 'utf8',
          env: childEnv(),
        });
        return new Set(parseSessionList(syncOutput(result))
          .filter(row => row?.running !== false && typeof row?.name === 'string')
          .map(row => row.name));
      } catch {
        return new Set();
      }
    };

    const sessionRunningSync = name => {
      try {
        const result = spawner('herdr', ['session', 'list', '--json'], {
          sync: true,
          encoding: 'utf8',
          env: childEnv(),
        });
        return parseSessionList(syncOutput(result))
          .some(row => row.name === name && row.running !== false);
      } catch {
        return false;
      }
    };

    const ensureSessionRunningSync = name => {
      if (sessionRunningSync(name)) return;
      let child;
      try {
        child = spawner('herdr', ['--session', name, 'server'], {
          detach: true,
          detached: true,
          stdio: 'ignore',
          env: childEnv(),
        });
      } catch (error) {
        throw new SessionCreateError(
          `failed to start herdr session "${name}": ${error.message}`, error,
        );
      }
      if (child?.error) {
        throw new SessionCreateError(
          `failed to start herdr session "${name}": ${child.error.message}`, child.error,
        );
      }
      for (let attempt = 0; attempt < SERVER_POLL_ATTEMPTS; attempt += 1) {
        sleepSync(SERVER_POLL_MS);
        if (sessionRunningSync(name)) return;
      }
      throw new SessionCreateError(`herdr session "${name}" server did not start`);
    };

    const syncCall = (args, name, operation) => {
      let result;
      try {
        result = spawner('herdr', args, {
          sync: true,
          encoding: 'utf8',
          env: childEnv(),
        });
      } catch (error) {
        throw new SessionCreateError(
          `failed to ${operation} herdr session "${name}": ${error.message}`, error,
        );
      }
      if (result?.error) {
        throw new SessionCreateError(
          `failed to ${operation} herdr session "${name}": ${result.error.message}`, result.error,
        );
      }
      if (result?.status !== null && result?.status !== undefined && result.status !== 0) {
        const stderr = result.stderr ? `: ${String(result.stderr).trim()}` : '';
        throw new SessionCreateError(
          `failed to ${operation} herdr session "${name}"${stderr}`,
        );
      }
      return syncOutput(result);
    };

    const backend = {
      name: 'herdr',
      owner,
      SUBMIT_DELAY_MS,

      ensureSessionRunning,

      available() {
        try {
          const result = spawner('herdr', ['--version'], {
            sync: true,
            encoding: 'utf8',
            env: childEnv(),
          });
          if (result.status !== 0) return false;
          const version = parseVersion(result.stdout);
          return !!version && versionAtLeast(version, MIN_VERSION);
        } catch {
          return false;
        }
      },

      inside() {
        return !!(env.HERDR_ENV || env.HERDR_PANE_ID);
      },

      currentPaneId() {
        if (env.UNSNOOZE_MUX === 'herdr' && env.UNSNOOZE_PANE) return env.UNSNOOZE_PANE;
        return env.HERDR_PANE_ID || null;
      },

      async capturePane(pane, lines = 200) {
        return owned('pane', 'read', String(pane),
          '--source', 'recent', '--lines', String(lines), '--format', 'text');
      },

      async capturePaneVisible(pane) {
        return owned('pane', 'read', String(pane), '--source', 'visible', '--format', 'text');
      },

      async sendText(pane, text) {
        await owned('pane', 'send-text', String(pane), text);
        await new Promise(resolve => setTimeout(resolve, SUBMIT_DELAY_MS));
        await owned('pane', 'send-keys', String(pane), 'enter');
      },

      async sendKey(pane, key) {
        const named = KEY_MAP[key];
        if (named) {
          await owned('pane', 'send-keys', String(pane), named);
          return;
        }
        await owned('pane', 'send-text', String(pane), key);
      },

      async paneAlive(pane) {
        try {
          const result = parseResult(await owned('pane', 'get', String(pane)));
          return result?.pane?.pane_id === String(pane);
        } catch {
          return false;
        }
      },

      async sessionForPane(_pane) {
        if (owner) return owner;
        if (env.HERDR_SESSION) return env.HERDR_SESSION;
        return backend.inside() ? 'default' : null;
      },

      async paneCurrentCommand(pane) {
        try {
          const info = parseResult(
            await owned('pane', 'process-info', '--pane', String(pane)),
          )?.process_info;
          const processes = info?.foreground_processes;
          if (!Array.isArray(processes) || processes.length === 0) return null;
          const foreground = processes.find(process =>
            process.pid === info.foreground_process_group_id) || processes[0];
          if (Array.isArray(foreground.argv) && foreground.argv[0]) {
            return basename(foreground.argv[0].split(/\s+/)[0]);
          }
          return foreground.name ? basename(foreground.name) : null;
        } catch {
          return null;
        }
      },

      async sessionExists(name) {
        try {
          return (await backend.listSessions()).some(row => row.name === name);
        } catch {
          return false;
        }
      },

      async listSessions() {
        try {
          const result = parseResult(await run(['session', 'list', '--json']));
          const rows = Array.isArray(result?.sessions) ? result.sessions : [];
          return rows
            .filter(row => typeof row?.name === 'string' && row.name)
            .map(row => ({ name: row.name, exited: row.running === false }));
        } catch {
          return [];
        }
      },

      async listSessionPanes(sessionName) {
        try {
          const result = parseResult(await inSession(sessionName, 'pane', 'list'));
          const panes = Array.isArray(result?.panes) ? result.panes : [];
          return panes.map(entry => String(entry.pane_id)).filter(Boolean);
        } catch {
          return [];
        }
      },

      async closePane(pane) {
        await owned('pane', 'close', String(pane));
      },

      async deleteSession(name) {
        try {
          await run(['session', 'stop', name]);
        } catch {
          // The session may already be stopped or unreachable.
        }
        await run(['session', 'delete', name]);
      },

      async newWindow(sessionName, cwd, launchSpec) {
        await ensureSessionRunning(sessionName);
        const workspace = parseResult(await inSession(
          sessionName, 'workspace', 'create', '--cwd', cwd, '--label', 'unsnooze',
          ...envFlags(launchSpec?.env),
        ));
        const pane = workspace?.root_pane?.pane_id;
        if (!pane) throw new Error('unsnooze: unexpected herdr workspace shape: no root_pane');
        await inSession(sessionName, 'pane', 'run', String(pane), launchSpec.file, ...(launchSpec.args || []));
        // `pane run` writes the argv into the pane's shell but does not submit
        // it. Submit explicitly so revived agents actually start.
        await inSession(sessionName, 'pane', 'send-keys', String(pane), 'enter');
        return { pane: String(pane), paneOwner: sessionName };
      },

      launchWrapped(launchSpec) {
        const live = liveSessionNames();
        const name = resolveSessionName(wrappedSessionName(env), candidate => live.has(candidate));
        try {
          ensureSessionRunningSync(name);
          const workspace = parseResult(syncCall([
            '--session', name, 'workspace', 'create', '--cwd', process.cwd(), '--label', 'unsnooze',
            ...envFlags(launchSpec?.env),
          ], name, 'create workspace'));
          const pane = workspace?.root_pane?.pane_id;
          if (!pane) throw new Error('unsnooze: unexpected herdr workspace shape: no root_pane');
          syncCall([
            '--session', name, 'pane', 'run', String(pane), launchSpec.file, ...(launchSpec.args || []),
          ], name, 'run pane');
          syncCall([
            '--session', name, 'pane', 'send-keys', String(pane), 'enter',
          ], name, 'submit pane command');
        } catch (error) {
          if (error instanceof SessionCreateError) throw error;
          throw new SessionCreateError(
            `failed to start herdr session "${name}": ${error.message}`, error,
          );
        }

        const result = spawner('herdr', ['session', 'attach', name], {
          sync: true,
          stdio: 'inherit',
          env: childEnv(),
        });
        if (result?.error) {
          throw new SessionCreateError(
            `failed to attach herdr session "${name}": ${result.error.message}`, result.error,
          );
        }
        return exitStatus(result);
      },

      bind(nextOwner) {
        return build(nextOwner);
      },
    };

    return backend;
  };

  return build(null);
}

const herdr = createHerdr();

export const available = (...args) => herdr.available(...args);
export const inside = (...args) => herdr.inside(...args);
export const currentPaneId = (...args) => herdr.currentPaneId(...args);
export const launchWrapped = (...args) => herdr.launchWrapped(...args);

export default herdr;
