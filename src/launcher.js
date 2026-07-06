// Default `csg [claude args...]` path: run claude under watch.
//   - outside tmux: re-exec inside a new tmux session (the monitor needs a pane
//     to scrape) — guarded by CSG_ACTIVE to prevent recursion
//   - inside tmux: spawn a detached per-pane monitor, then run claude,
//     propagating its exit code
//   - -p/--print: pure pass-through, no monitor (nothing interactive to scrape)

import { spawn, spawnSync } from 'node:child_process';
import { insideTmux, currentPaneId } from './tmux.js';
import { spawnDetached } from './spawn.js';
import { makeLogger } from './logger.js';

const log = makeLogger('launcher');

const REAL_CLAUDE = process.env.CSG_CLAUDE_BIN || 'claude';

function isPrintMode(args) {
  return args.includes('-p') || args.includes('--print');
}

export function runLauncher(args) {
  // Recursion / nested-launch guard: inside a csg-managed claude, a plain
  // `claude`/`csg` call goes straight through.
  if (process.env.CSG_ACTIVE === '1' || isPrintMode(args)) {
    const r = spawnSync(REAL_CLAUDE, args, { stdio: 'inherit', env: { ...process.env, CSG_ACTIVE: '1' } });
    return r.status ?? 1;
  }

  if (!insideTmux()) {
    // Re-enter under tmux: `tmux new-session csg <args...>` — the inner csg
    // lands in the insideTmux() branch below.
    log(`not in tmux — wrapping into a tmux session`);
    const inner = ['new-session', process.execPath, process.argv[1], ...args];
    const r = spawnSync('tmux', inner, { stdio: 'inherit' });
    return r.status ?? 1;
  }

  const pane = currentPaneId();
  if (pane) {
    spawnDetached(['_monitor', pane], { CSG_CWD: process.cwd() });
    log(`launching claude in pane ${pane}, monitor spawned`);
  } else {
    log('inside tmux but TMUX_PANE unset — launching without monitor');
  }

  const child = spawn(REAL_CLAUDE, args, {
    stdio: 'inherit',
    env: { ...process.env, CSG_ACTIVE: '1', CSG_PANE: pane || '' },
  });
  return new Promise(resolve => {
    child.on('exit', code => resolve(code ?? 1));
    child.on('error', err => {
      process.stderr.write(`csg: failed to launch ${REAL_CLAUDE}: ${err.message}\n`);
      resolve(127);
    });
  });
}
