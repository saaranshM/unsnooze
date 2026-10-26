import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { AgentDispatchedError, resolveSessionName, SessionCreateError } from './session-name.js';

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
  return [
    'layout {',
    `  pane command=${kdlString(argv[0])} close_on_exit=true {`,
    `    args ${argv.slice(1).map(kdlString).join(' ')}`,
    '  }',
    '}',
    '',
  ].join('\n');
}

const SESSION_NAME_TAKEN_RE = /Session with name .+ already exists\./i;
const SESSION_START_ERROR_RE = /Failed to parse Zellij configuration|invalid value .*--session|session name must be less than|Session .+ not found/i;

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

  // dump-screen --full (scrollback) exists on zellij >= 0.35; older builds
  // reject the flag. Shared across binds: learn once, never fail every tick.
  // null = untested, true = supported, false = degrade to viewport-only.
  let fullDumpSupported = null;

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

      // --full includes scrollback, so a banner/menu that scrolled away
      // between polls is still seen; `lines` is still ignored — zellij offers
      // no line-count bound on the dump. Pre-0.35 zellij rejects the flag:
      // fall back to the viewport-only form (1.10.x behavior) rather than
      // failing every capture, and remember the answer.
      async capturePane(pane, _lines = 200) {
        if (fullDumpSupported !== false) {
          try {
            const out = await owned('action', 'dump-screen', '--full', '--pane-id', String(pane));
            fullDumpSupported = true;
            return out;
          } catch (err) {
            if (fullDumpSupported === true) throw err;   // flag is fine — real capture error
            fullDumpSupported = false;
          }
        }
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
        // Use an exclusive named session with its own one-pane layout. `attach
        // --create` only runs its initial command when it wins creation and is
        // new in Zellij 0.45.1; the older root layout API can target a named
        // session, but needs --new-session-with-layout to create one.
        const base = wrappedSessionName(env);
        const taken = liveSessionNames();
        const attempted = new Set();
        let name = resolveSessionName(base, candidate => taken.has(candidate));
        let layoutDir;

        try {
          layoutDir = mkdtempSync(join(tmpdir(), 'unsnooze-zellij-'));
          const layoutPath = join(layoutDir, 'wrapped.kdl');
          writeFileSync(layoutPath, wrappedLayout(launchSpec), { mode: 0o600 });

          while (!attempted.has(name)) {
            attempted.add(name);
            const result = spawner('zellij', [
              '--session', name, '--new-session-with-layout', layoutPath,
            ], {
              sync: true, stdio: ['inherit', 'inherit', 'pipe'], env: childEnv(),
            });
            if (result?.error) {
              throw new SessionCreateError(
                `failed to start zellij session "${name}": ${result.error.message}`,
                result.error,
              );
            }

            const status = exitStatus(result);
            const stderr = result?.stderr == null ? '' : String(result.stderr);
            const nameTaken = status !== 0 && SESSION_NAME_TAKEN_RE.test(stderr);
            if (nameTaken) {
              taken.add(name);
              const next = resolveSessionName(base, candidate =>
                taken.has(candidate) || attempted.has(candidate));
              if (attempted.has(next)) {
                throw new SessionCreateError(
                  `could not find an unused zellij session name for "${base}": ${stderr.trim()}`,
                );
              }
              name = next;
              continue;
            }

            if (status !== 0 && SESSION_START_ERROR_RE.test(stderr)) {
              throw new SessionCreateError(
                `failed to start zellij session "${name}": ${stderr.trim()}`,
              );
            }

            if (status !== 0) {
              // A foreground client can fail after the pane command has been
              // dispatched, leaving the session live. Since stdout must stay
              // attached for the Zellij UI, a duplicate-name error printed
              // there cannot be distinguished from a post-dispatch failure.
              // Never retry an ambiguous live session: that could start the
              // agent twice.
              if (!taken.has(name) && liveSessionNames().has(name)) {
                if (stderr.trim()) process.stderr.write(stderr);
                throw new AgentDispatchedError(
                  `zellij exited with status ${status} while session "${name}" remained live; `
                  + 'the agent may already be running, so unsnooze did not retry it',
                  { mux: 'zellij' },
                );
              }
              if (stderr.trim()) process.stderr.write(stderr);
              return status;
            }

            // This callback writes ownership proof. Invoke it only if the
            // exclusive create succeeded and its session survived the
            // foreground client, never for a colliding or already-closed one.
            if (liveSessionNames().has(name)) launchSpec.onSessionCreated?.(name);
            if (stderr.trim()) process.stderr.write(stderr);
            return status;
          }

          throw new SessionCreateError(`could not find an unused zellij session name for "${base}"`);
        } finally {
          if (layoutDir) {
            try { rmSync(layoutDir, { recursive: true, force: true }); } catch { /* best effort */ }
          }
        }
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
