import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

import { SessionCreateError } from './session-name.js';

const execFileAsync = promisify(execFileCb);
const MIN_VERSION = [0, 7, 5];

function defaultSpawner(file, args, { sync = false, ...options } = {}) {
  if (sync) return spawnSync(file, args, options);
  return execFileAsync(file, args, options).then(({ stdout }) => stdout);
}

function scrubHerdrEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('HERDR')));
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

  const build = owner => {
    const owned = (...args) => {
      if (!owner) throw new Error('unsnooze: herdr pane operation requires a session owner');
      return run(['--session', owner, ...args]);
    };
    const inSession = (session, ...args) => {
      if (!session) throw new Error('unsnooze: herdr pane operation requires a session owner');
      return run(['--session', session, ...args]);
    };

    const backend = {
      name: 'herdr',
      owner,
      SUBMIT_DELAY_MS,

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

export default herdr;
