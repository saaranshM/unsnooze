// Default `unsnooze _run <agent> [args...]` path: run the agent CLI under watch.
//   - outside tmux: re-exec inside a new tmux session (the monitor needs a pane
//     to scrape) — guarded by UNSNOOZE_ACTIVE to prevent recursion
//   - inside tmux: spawn a detached per-pane monitor, then run the CLI,
//     propagating its exit code
//   - -p/--print: pure pass-through, no monitor (nothing interactive to scrape)

import { spawn, spawnSync } from 'node:child_process';
import { insideTmux, currentPaneId, tmuxAvailable } from './tmux.js';
import { getAgent } from './agents/index.js';
import { getConfig } from './settings.js';
import { spawnDetached } from './spawn.js';
import { makeLogger } from './logger.js';

const log = makeLogger('launcher');

function isPrintMode(args) {
  return args.includes('-p') || args.includes('--print');
}

export function runLauncher(args, agentId = 'claude') {
  const agent = getAgent(agentId);

  // Recursion / nested-launch guard: inside an unsnooze-managed session, a
  // plain `claude`/`codex`/`unsnooze` call goes straight through. Same for an
  // agent the user disabled in settings — run it, don't watch it.
  if (process.env.UNSNOOZE_ACTIVE === '1' || isPrintMode(args) || !getConfig(`agents.${agent.id}`)) {
    const r = spawnSync(agent.bin, args, { stdio: 'inherit', env: { ...process.env, UNSNOOZE_ACTIVE: '1' } });
    return r.status ?? 1;
  }

  if (!insideTmux()) {
    if (!tmuxAvailable()) {
      // Degrade gracefully: run the CLI unwatched rather than dying.
      process.stderr.write('unsnooze: tmux not found — running without limit-watch.\n');
      if (process.platform === 'win32') {
        process.stderr.write('unsnooze: native Windows is not supported; run inside WSL (https://learn.microsoft.com/windows/wsl/install) where tmux works.\n');
      } else {
        process.stderr.write('unsnooze: install tmux to enable auto-resume (brew install tmux / apt install tmux).\n');
      }
      const r = spawnSync(agent.bin, args, { stdio: 'inherit', env: { ...process.env, UNSNOOZE_ACTIVE: '1' } });
      return r.status ?? 1;
    }
    // Re-enter under tmux: `tmux new-session unsnooze _run <agent> <args...>` —
    // the inner unsnooze lands in the insideTmux() branch below.
    log(`not in tmux — wrapping into a tmux session`);
    const inner = ['new-session', process.execPath, process.argv[1], '_run', agent.id, ...args];
    const r = spawnSync('tmux', inner, { stdio: 'inherit' });
    return r.status ?? 1;
  }

  const pane = currentPaneId();
  if (pane) {
    spawnDetached(['_monitor', pane, agent.id], { UNSNOOZE_CWD: process.cwd() });
    log(`launching ${agent.id} in pane ${pane}, monitor spawned`);
  } else {
    log(`inside tmux but TMUX_PANE unset — launching ${agent.id} without monitor`);
  }

  const child = spawn(agent.bin, args, {
    stdio: 'inherit',
    env: { ...process.env, UNSNOOZE_ACTIVE: '1', UNSNOOZE_PANE: pane || '' },
  });
  return new Promise(resolve => {
    child.on('exit', code => resolve(code ?? 1));
    child.on('error', err => {
      process.stderr.write(`unsnooze: failed to launch ${agent.bin}: ${err.message}\n`);
      resolve(127);
    });
  });
}
