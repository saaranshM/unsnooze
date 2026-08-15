// Default `unsnooze _run <agent> [args...]` path: run the agent CLI under watch.
//   - outside a multiplexer: re-exec through its launchWrapped operation
//   - inside one: spawn a detached per-pane monitor, then run the CLI,
//     propagating its exit code
//   - -p/--print: pure pass-through, no monitor (nothing interactive to scrape)

import { spawn, spawnSync } from 'node:child_process';
import { getMultiplexer } from './multiplexer.js';
import { getAgent } from './agents/index.js';
import { getConfig } from './settings.js';
import { spawnDetached, monitorSpawnArgs } from './spawn.js';
import { makeLogger } from './logger.js';
import { createLeaseId, processBirth, writeLease, removeLease } from './lease.js';
import { recordOwnedSession } from './mux-sessions.js';
import { SessionCreateError } from './multiplexers/session-name.js';

const log = makeLogger('launcher');

function isPrintMode(args) {
  return args.includes('-p') || args.includes('--print');
}

export function resolvePaneOwner(muxName, env = process.env) {
  if (muxName === 'herdr') {
    return (env.UNSNOOZE_MUX === 'herdr'
      ? env.UNSNOOZE_PANE_OWNER : env.HERDR_SESSION || 'default') || null;
  }
  if (muxName === 'zellij') {
    return (env.UNSNOOZE_MUX === 'zellij'
      ? env.UNSNOOZE_PANE_OWNER : env.ZELLIJ_SESSION_NAME) || null;
  }
  return null;
}

function runUnwatched(agent, args, reason) {
  if (reason) process.stderr.write(`unsnooze: ${reason}\n`);
  const r = spawnSync(agent.bin, args, { stdio: 'inherit', env: { ...process.env, UNSNOOZE_ACTIVE: '1' } });
  return r.status ?? 1;
}

export function runLauncher(args, agentId = 'claude', { processBirthFn = processBirth } = {}) {
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
      return runUnwatched(agent, args);
    }
    log(`not in ${mux.name} — wrapping into a managed session`);
    try {
      // A returned status is the agent's (or session's) exit — never re-run.
      return mux.launchWrapped({
        file: process.execPath,
        args: [process.argv[1], '_run', agent.id, ...args],
        env: process.env,
        // Written before the session is used, not after: a launch that dies
        // halfway still leaves the evidence reap needs to clean up after it.
        // Without this, reap has no proof of ownership and (correctly) refuses
        // to delete anything.
        onSessionCreated: name => recordOwnedSession({ mux: mux.name, name }),
      });
    } catch (err) {
      // Session creation failed (tmux/zellij binary spawn, unexpected throw).
      // Never brick the user's `claude`/`codex` — fall back unwatched.
      const msg = err instanceof SessionCreateError
        ? `${err.message} — running without limit-watch.`
        : `failed to wrap into ${mux.name} (${err.message}) — running without limit-watch.`;
      log(`launchWrapped failed: ${err.stack || err}`);
      return runUnwatched(agent, args, msg);
    }
  }

  const rawPane = mux.currentPaneId();
  const paneOwner = resolvePaneOwner(mux.name, process.env);
  // A backend may know it cannot safely address the pane it is sitting in —
  // herdr's pane ids are per-server, and an ambient custom socket can point our
  // commands at a different server's identically-numbered pane. Watching
  // nothing beats typing into someone else's terminal, so drop to the same
  // no-pane path a missing pane id already takes: the agent runs normally,
  // just unwatched, and the user is told why.
  const addressable = typeof mux.paneAddressable !== 'function' || mux.paneAddressable();
  if (rawPane && !addressable) {
    const why = typeof mux.addressabilityReason === 'function'
      ? mux.addressabilityReason() : `${mux.name} pane ${rawPane} is not safely addressable`;
    process.stderr.write(`unsnooze: ${why} — running ${agent.id} without limit-watch.\n`);
    log(`pane ${rawPane} not addressable: ${why}`);
  }
  const pane = addressable ? rawPane : null;
  const leaseId = process.env.UNSNOOZE_LEASE_ID || createLeaseId();
  if (pane) {
    // Stamp our own pane (best-effort, tmux only): the identity every later
    // close/inject decision verifies against — pane ids get recycled.
    if (typeof mux.stampPaneOwner === 'function') {
      mux.stampPaneOwner(pane, leaseId).catch(() => { /* legacy tmux */ });
    }
    spawnDetached(
      monitorSpawnArgs({ muxName: mux.name, paneOwner, pane, agentId: agent.id, leaseId }),
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
    pid: child.pid, pidBirth: processBirthFn(child.pid),
  } : null;
  // Write it even when the birth timestamp is unavailable. processBirth only
  // reads /proc on linux and `ps` on darwin, so it is null on Windows and on
  // any ps failure — and gating the write on it meant a perfectly healthy
  // agent there got no lease at all. The monitor reads presence to know its
  // agent is alive; ownership checks stay exactly as strict, because
  // leaseMatches() still refuses to match a lease with a null birth.
  if (lease) writeLease(lease);
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
