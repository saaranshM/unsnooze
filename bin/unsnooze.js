#!/usr/bin/env node
// unsnooze — subcommand router; anything unrecognized is treated as claude
// args and passed through the launcher (back-compat with the zsh wrapper).

const [, , cmd, ...rest] = process.argv;

// Only human-facing commands may print update notices — never the wrapper
// passthrough, hooks, or daemons (their output lands in agent panes/logs).
const USER_FACING = new Set(['status', 'resume-now', 'cancel', 'message', 'config', 'logs', 'report', 'help', '-h', '--help', '--help-unsnooze']);

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
    case 'install': {
      const { cmdInstall } = await import('../src/install.js');
      return cmdInstall(rest);
    }
    case 'uninstall': {
      const { cmdUninstall } = await import('../src/install.js');
      return cmdUninstall(rest);
    }
    case '_hook-stopfailure': {
      const { runHook } = await import('../src/hook.js');
      return runHook(rest);
    }
    case '_monitor': {
      if (!rest[0]) { console.error('unsnooze _monitor: pane id required'); return 2; }
      const { runMonitor } = await import('../src/monitor.js');
      return runMonitor(rest[0], rest[1]);
    }
    case '_run': {
      if (!rest[0]) { console.error('unsnooze _run: agent id required'); return 2; }
      const { runLauncher } = await import('../src/launcher.js');
      return runLauncher(rest.slice(1), rest[0]);
    }
    case '_resumer': {
      const { runResumer } = await import('../src/resumer.js');
      return runResumer();
    }
    case 'update': {
      const { runSelfUpdate } = await import('../src/update-check.js');
      return runSelfUpdate();
    }
    case '_update-check': {
      const { runUpdateCheck } = await import('../src/update-check.js');
      return runUpdateCheck();
    }
    case 'daemon': {
      // Persistent resumer + transcript watcher: detects and revives limit
      // stops from GUI surfaces (VS Code extension, desktop apps) where no
      // shell wrapper or tmux pane exists. Run via launchd/systemd or a shell.
      const { runResumer } = await import('../src/resumer.js');
      const { createWatcher } = await import('../src/watcher.js');
      const controller = new AbortController();
      process.on('SIGTERM', () => controller.abort());
      process.on('SIGINT', () => controller.abort());
      // Daily update check from the daemon: GUI-only users never run CLI
      // commands, so this is what gets them the "new version" desktop toast.
      const { spawnDetached } = await import('../src/spawn.js');
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
  unsnooze logs [-f]               show (or follow) the unsnooze log
  unsnooze update                  update unsnooze itself to the latest version
  unsnooze daemon                  persistent watcher for GUI sessions (VS Code
                                   extension, desktop apps) — no tmux needed to
                                   detect; revival still opens in tmux
  unsnooze config [list|get|set]   view or change settings (toggles, global +
                                   per-agent resume messages, updateCheck)
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
      const { runLauncher } = await import('../src/launcher.js');
      const args = cmd === undefined ? [] : [cmd, ...rest];
      return runLauncher(args, 'claude');
    }
  }
}

main().then(async code => {
  if (USER_FACING.has(cmd)) await maybeUpdateNotices();
  process.exitCode = typeof code === 'number' ? code : 0;
}).catch(err => { console.error(`unsnooze: ${err.stack || err}`); process.exitCode = 1; });
