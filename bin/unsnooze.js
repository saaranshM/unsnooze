#!/usr/bin/env node
// unsnooze — subcommand router; anything unrecognized is treated as claude
// args and passed through the launcher (back-compat with the zsh wrapper).

import { spawnSync } from 'node:child_process';

const [, , cmd, ...rest] = process.argv;

// --- upgrade-window fail-safe -----------------------------------------------
// During `npm install -g` the package dir is briefly half-written: bin/ can
// exist while src/ is missing, so the zsh wrapper's file guard passes but the
// dynamic imports below throw ERR_MODULE_NOT_FOUND. That window once produced
// an instantly-dying wrapped tmux session for every `claude` (and 12,989
// launchd daemon crash-loops). Rules: agent-launch paths degrade to the plain
// CLI; background paths (hook/monitor/resumer/daemon) exit 0 quietly. Only
// module LOAD failures are caught — a runtime error after the module loaded
// must not re-run an agent that may already have run.

// Mirrors each adapter's bin resolution without importing src/. Codex loses
// its PATH walk here — plain `codex` is the correct degraded answer.
const AGENT_FALLBACK_BINS = {
  claude: () => process.env.UNSNOOZE_CLAUDE_BIN || 'claude',
  codex: () => process.env.UNSNOOZE_CODEX_BIN || 'codex',
  grok: () => process.env.UNSNOOZE_GROK_BIN || 'grok',
  qwen: () => process.env.UNSNOOZE_QWEN_BIN || 'qwen',
  kimi: () => process.env.UNSNOOZE_KIMI_BIN || 'kimi',
  opencode: () => process.env.UNSNOOZE_OPENCODE_BIN || 'opencode',
  agy: () => process.env.UNSNOOZE_AGY_BIN || 'agy',
};

async function safeImport(specifier) {
  try {
    return await import(specifier);
  } catch {
    return null;   // missing/half-written module — caller picks the degraded path
  }
}

function runAgentFallback(agentId, args) {
  const bin = (AGENT_FALLBACK_BINS[agentId] || AGENT_FALLBACK_BINS.claude)();
  process.stderr.write('unsnooze: install incomplete (upgrade in progress?) — running without limit-watch.\n');
  const r = spawnSync(bin, args, {
    stdio: 'inherit',
    env: { ...process.env, UNSNOOZE_ACTIVE: '1' },
  });
  return r.status ?? 1;
}

// Only human-facing commands may print update notices — never the wrapper
// passthrough, hooks, or daemons (their output lands in agent panes/logs).
const USER_FACING = new Set(['status', 'resume-now', 'cancel', 'message', 'config', 'logs', 'report', 'sessions', 'reap', 'doctor', 'preview', 'help', '-h', '--help', '--help-unsnooze']);

// Every named subcommand; anything else (or no args) is an agent launch.
const NAMED_COMMANDS = new Set([
  ...USER_FACING, 'setup', 'install', 'uninstall', 'update', 'daemon',
  '_hook-stopfailure', '_monitor', '_run', '_resumer', '_update-check',
]);
const isLaunchPath = cmd === '_run' || cmd === undefined || !NAMED_COMMANDS.has(cmd);
const launchArgs = cmd === '_run' ? rest.slice(1) : (cmd === undefined ? [] : [cmd, ...rest]);

// Post-session update notice (update-notifier pattern): wrapper-only users
// never run `unsnooze status`, so the moment the agent exits — screen
// restored, user at their prompt — is where a notice reliably reaches them.
// Outer process only: inside any multiplexer our stderr is a pane that may be
// about to close (wrapped sessions die with the agent); the outer wrapper
// prints on the real terminal after tmux/zellij hands the screen back.
async function maybeLaunchExitNotice(args) {
  try {
    if (process.env.TMUX || process.env.ZELLIJ || process.env.UNSNOOZE_ACTIVE === '1') return;
    if (!process.stderr.isTTY) return;                            // pipes, CI, scripts
    if (args.includes('-p') || args.includes('--print')) return;  // non-interactive runs
    const mod = await safeImport('../src/update-check.js');
    if (!mod) return;
    const notice = mod.launchExitNotice();
    if (notice) process.stderr.write(`\n${notice}\n`);
    // Keep the cache fresh for users who only ever launch agents — without
    // this, no daemon and no user-facing command means no check ever runs.
    if (mod.isCacheStale()) {
      const spawnMod = await safeImport('../src/spawn.js');
      spawnMod?.spawnDetached(['_update-check']);
    }
  } catch { /* notices must never break the launch path */ }
}

async function maybeUpdateNotices() {
  try {
    const { whatsNewNotice, updateNotice, isCacheStale } = await import('../src/update-check.js');
    const whatsNew = whatsNewNotice();
    if (whatsNew) console.error(`\n${whatsNew}`);
    const notice = updateNotice();
    if (notice) console.error(`\n${notice}`);
    if (isCacheStale()) {
      const { spawnDetached } = await import('../src/spawn.js');
      spawnDetached(['_update-check']);
    }
  } catch { /* update UX must never break a command */ }
}

async function main() {
  switch (cmd) {
    case 'status': {
      const { cmdStatus } = await import('../src/cli.js');
      return cmdStatus();
    }
    case 'resume-now': {
      const { cmdResumeNow } = await import('../src/cli.js');
      return cmdResumeNow(rest[0]);
    }
    case 'cancel': {
      const { cmdCancel } = await import('../src/cli.js');
      return cmdCancel(rest[0]);
    }
    case 'logs': {
      const { cmdLogs } = await import('../src/cli.js');
      return cmdLogs(rest.includes('-f'));
    }
    case 'setup': {
      const { runWizard } = await import('../src/wizard.js');
      return runWizard();
    }
    case 'report': {
      const { cmdReport } = await import('../src/report.js');
      return cmdReport(rest);
    }
    case 'message': {
      const { cmdMessage } = await import('../src/cli.js');
      return cmdMessage(rest);
    }
    case 'config': {
      const { cmdConfig } = await import('../src/cli.js');
      return cmdConfig(rest);
    }
    case 'sessions': {
      const { cmdSessions } = await import('../src/cli.js');
      return cmdSessions();
    }
    case 'reap': {
      const { cmdReap } = await import('../src/cli.js');
      return cmdReap(rest);
    }
    case 'doctor': {
      const { cmdDoctor } = await import('../src/doctor.js');
      return cmdDoctor(rest);
    }
    case 'preview': {
      const { cmdPreview } = await import('../src/cli.js');
      return cmdPreview(rest);
    }
    case 'install': {
      const { cmdInstall } = await import('../src/install.js');
      return cmdInstall(rest);
    }
    case 'uninstall': {
      const { cmdUninstall } = await import('../src/install.js');
      return cmdUninstall(rest);
    }
    case '_hook-stopfailure': {
      const mod = await safeImport('../src/hook.js');
      if (!mod) return 0;   // never fail (or pollute) an agent turn
      return mod.runHook(rest);
    }
    case '_monitor': {
      if (!rest[0] || !rest[2]) { console.error('unsnooze _monitor: mux owner pane required'); return 2; }
      const mod = await safeImport('../src/monitor.js');
      if (!mod) return 0;   // detached — nothing useful to report
      return mod.runMonitor(rest[0], rest[1], rest[2], rest[3], rest[4]);
    }
    case '_run': {
      if (!rest[0]) { console.error('unsnooze _run: agent id required'); return 2; }
      const mod = await safeImport('../src/launcher.js');
      if (!mod) return runAgentFallback(rest[0], rest.slice(1));
      return mod.runLauncher(rest.slice(1), rest[0]);
    }
    case '_resumer': {
      const mod = await safeImport('../src/resumer.js');
      if (!mod) return 0;
      return mod.runResumer();
    }
    case 'update': {
      const { runSelfUpdate } = await import('../src/update-check.js');
      return runSelfUpdate();
    }
    case '_update-check': {
      const mod = await safeImport('../src/update-check.js');
      if (!mod) return 0;
      return mod.runUpdateCheck();
    }
    case 'daemon': {
      // Persistent resumer + transcript watcher: detects and revives limit
      // stops from GUI surfaces (VS Code extension, desktop apps) where no
      // shell wrapper or multiplexer pane exists. Run via launchd/systemd or a shell.
      // Exit 0 on load failure: with launchd KeepAlive a crash here means an
      // instant-respawn crash-loop for the whole upgrade window.
      const resumerMod = await safeImport('../src/resumer.js');
      const watcherMod = await safeImport('../src/watcher.js');
      if (!resumerMod || !watcherMod) return 0;
      const { runResumer } = resumerMod;
      const { createWatcher } = watcherMod;
      const controller = new AbortController();
      process.on('SIGTERM', () => controller.abort());
      process.on('SIGINT', () => controller.abort());
      // Self-heal pre-1.12 autostart units: they lack PATH, so this daemon
      // cannot find tmux and every revival dies. Healing rewrites the unit
      // and reloads it — which intentionally kills THIS process; the
      // supervisor restarts us under the fixed unit. One-time: healed units
      // pass the check forever after.
      const installMod = await safeImport('../src/install.js');
      if (installMod?.healDaemonAutostart) {
        try {
          const healed = installMod.healDaemonAutostart();
          if (healed) {
            const lm = await safeImport('../src/logger.js');
            lm?.log('daemon', `autostart unit lacked PATH — regenerated ${healed}, reloading (self-heal)`);
          }
        } catch { /* heal is best-effort — a broken unit must not block the daemon */ }
      }
      // daemon.log is launchd/systemd-captured stdout+stderr. launchd holds
      // an open fd on it for our whole lifetime, so rotation must be
      // copy-truncate: renaming would leave launchd appending to the renamed
      // inode forever, with no fresh daemon.log until the next respawn.
      const loggerMod = await safeImport('../src/logger.js');
      const configMod = await safeImport('../src/config.js');
      if (loggerMod && configMod) {
        const { join } = await import('node:path');
        loggerMod.copyTruncateIfLarge(join(configMod.STATE_DIR, 'daemon.log'));
      }
      // Version-skew guard: when npm swaps the package underneath us, exit
      // cleanly so launchd/systemd restart the daemon on the fresh code.
      const updMod = await safeImport('../src/update-check.js');
      if (updMod?.hasVersionSkew) {
        setInterval(() => {
          if (updMod.hasVersionSkew()) controller.abort();
        }, 15 * 60_000).unref();
      }
      // Daily update check from the daemon: GUI-only users never run CLI
      // commands, so this is what gets them the "new version" desktop toast.
      const spawnMod = await safeImport('../src/spawn.js');
      if (!spawnMod) return 0;
      const { spawnDetached } = spawnMod;
      spawnDetached(['_update-check']);
      setInterval(() => spawnDetached(['_update-check']), 24 * 3_600_000).unref();
      return runResumer({ persistent: true, watcher: createWatcher(), signal: controller.signal });
    }
    case 'help':
    case '-h':
    case '--help':
    case '--help-unsnooze': {
      console.log(`unsnooze — wakes every limit-stopped AI coding session when the limit resets

Usage:
  unsnooze [claude args...]        run claude under limit-watch (default)
  unsnooze _run <agent> [args...]  run a specific agent CLI under limit-watch
  unsnooze status                  list tracked sessions + reset countdowns
  unsnooze resume-now [id|--all]   resume stopped session(s) immediately
  unsnooze cancel [id|--all]       stop tracking session(s)
  unsnooze message <id|--all> <t>  set a per-session wake message (--clear to reset)
  unsnooze sessions                list unsnooze-owned mux sessions + panes
  unsnooze reap [--dry-run|--yes]  close terminal-record panes / empty sessions
                                   (default: dry-run; pass --yes to apply)
  unsnooze doctor [--fix]          check install health; find (and with --fix
                                   retire) leftovers of the old
                                   claude-session-guard install
  unsnooze preview [id]            dry-run: what WOULD happen right now, and
                                   why — nothing is typed or opened (exit 2
                                   when a wake is actionable, else 0)
  unsnooze logs [-f]               show (or follow) the unsnooze log
  unsnooze update                  update unsnooze itself to the latest version
  unsnooze daemon                  persistent watcher for GUI sessions (VS Code
                                   extension, desktop apps) — no live pane needed
                                   to detect; revival opens in tmux or Zellij
  unsnooze config [list|get|set]   view or change settings (toggles, global +
                                   per-agent resume messages, notifyChannel
                                   auto|native|osc|bell, updateCheck)
  unsnooze setup                   interactive setup wizard (agents + toggles)
  unsnooze install [--yes]         wire up shell wrappers + hooks (non-interactive)
  unsnooze uninstall [--purge]     remove wrappers + hooks (and state with --purge)
  unsnooze report [agent] [pane]   capture a pane to report an undetected banner
  unsnooze help                    show this help (also -h / --help)`);
      return 0;
    }
    default: {
      // Everything else (including no args, --resume, -c, plain prompts) is a
      // claude invocation — back-compat for the plain wrapper.
      const args = cmd === undefined ? [] : [cmd, ...rest];
      const mod = await safeImport('../src/launcher.js');
      if (!mod) return runAgentFallback('claude', args);
      return mod.runLauncher(args, 'claude');
    }
  }
}

main().then(async code => {
  if (USER_FACING.has(cmd)) await maybeUpdateNotices();
  else if (isLaunchPath) await maybeLaunchExitNotice(launchArgs);
  process.exitCode = typeof code === 'number' ? code : 0;
}).catch(err => { console.error(`unsnooze: ${err.stack || err}`); process.exitCode = 1; });
