// Default `unsnooze _run <agent> [args...]` path: run the agent CLI under watch.
//   - outside a multiplexer: re-exec through its launchWrapped operation
//   - inside one: spawn a detached per-pane monitor, then run the CLI,
//     propagating its exit code
//   - -p/--print: pure pass-through, no monitor (nothing interactive to scrape)

import { spawn, spawnSync } from 'node:child_process';
import { getMultiplexer } from './multiplexer.js';
import { getAgent } from './agents/index.js';
import { getConfig } from './settings.js';
import { spawnDetached } from './spawn.js';
import { makeLogger } from './logger.js';
import { createLeaseId, processBirth, writeLease, removeLease } from './lease.js';

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

  const mux = getMultiplexer();
  if (!mux.inside()) {
    if (!mux.available()) {
      // Degrade gracefully: run the CLI unwatched rather than dying.
      process.stderr.write(`unsnooze: ${mux.name} not found — running without limit-watch.\n`);
      if (process.platform === 'win32') {
        process.stderr.write('unsnooze: native Windows is not supported; run inside WSL.\n');
      } else {
        process.stderr.write(`unsnooze: install ${mux.name} to enable auto-resume.\n`);
      }
      const r = spawnSync(agent.bin, args, { stdio: 'inherit', env: { ...process.env, UNSNOOZE_ACTIVE: '1' } });
      return r.status ?? 1;
    }
    log(`not in ${mux.name} — wrapping into a managed session`);
    return mux.launchWrapped({
      file: process.execPath,
      args: [process.argv[1], '_run', agent.id, ...args],
      env: process.env,
    });
  }

  const pane = mux.currentPaneId();
  const paneOwner = mux.name === 'zellij'
    ? (process.env.UNSNOOZE_MUX === 'zellij'
      ? process.env.UNSNOOZE_PANE_OWNER : process.env.ZELLIJ_SESSION_NAME) || null
    : null;
  const leaseId = process.env.UNSNOOZE_LEASE_ID || createLeaseId();
  if (pane) {
    spawnDetached(['_monitor', mux.name, paneOwner || '', pane, agent.id, leaseId],
      { UNSNOOZE_CWD: process.cwd() });
    log(`launching ${agent.id} in ${mux.name} ${paneOwner ?? '-'}:${pane}, monitor spawned`);
  } else {
    log(`inside ${mux.name} but pane id unset — launching ${agent.id} without monitor`);
  }

  const childEnv = {
    ...process.env, UNSNOOZE_ACTIVE: '1', UNSNOOZE_MUX: mux.name,
    UNSNOOZE_PANE: pane || '', UNSNOOZE_PANE_OWNER: paneOwner || '',
    UNSNOOZE_LEASE_ID: leaseId,
  };
  const child = spawn(agent.bin, args, {
    stdio: 'inherit',
    env: childEnv,
  });
  const lease = pane && child.pid ? {
    leaseId, mux: mux.name, paneOwner, pane, agent: agent.id,
    pid: child.pid, pidBirth: processBirth(child.pid),
  } : null;
  if (lease?.pidBirth) writeLease(lease);
  const cleanup = () => { if (lease) removeLease(lease, leaseId); };
  return new Promise(resolve => {
    child.on('exit', code => { cleanup(); resolve(code ?? 1); });
    child.on('error', err => {
      cleanup();
      process.stderr.write(`unsnooze: failed to launch ${agent.bin}: ${err.message}\n`);
      resolve(127);
    });
  });
}
