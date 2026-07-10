#!/usr/bin/env node
// unsnooze — subcommand router; anything unrecognized is treated as claude
// args and passed through the launcher (back-compat with the zsh wrapper).

const [, , cmd, ...rest] = process.argv;

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
    case 'daemon': {
      // Persistent resumer + transcript watcher: detects and revives limit
      // stops from GUI surfaces (VS Code extension, desktop apps) where no
      // shell wrapper or tmux pane exists. Run via launchd/systemd or a shell.
      const { runResumer } = await import('../src/resumer.js');
      const { createWatcher } = await import('../src/watcher.js');
      const controller = new AbortController();
      process.on('SIGTERM', () => controller.abort());
      process.on('SIGINT', () => controller.abort());
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
  unsnooze logs [-f]               show (or follow) the unsnooze log
  unsnooze daemon                  persistent watcher for GUI sessions (VS Code
                                   extension, desktop apps) — no tmux needed to
                                   detect; revival still opens in tmux
  unsnooze config [list|get|set]   view or change settings (toggles, global +
                                   per-agent resume messages)
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

main().then(code => { process.exitCode = typeof code === 'number' ? code : 0; })
  .catch(err => { console.error(`unsnooze: ${err.stack || err}`); process.exitCode = 1; });
