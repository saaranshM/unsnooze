#!/usr/bin/env node
// unsnooze — unsnooze. Subcommand router; anything unrecognized is
// treated as claude args and passed through the launcher.

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
      return runHook();
    }
    case '_monitor': {
      if (!rest[0]) { console.error('unsnooze _monitor: pane id required'); return 2; }
      const { runMonitor } = await import('../src/monitor.js');
      return runMonitor(rest[0]);
    }
    case '_resumer': {
      const { runResumer } = await import('../src/resumer.js');
      return runResumer();
    }
    case 'help':
    case '--help-unsnooze': {
      console.log(`unsnooze — unsnooze

Usage:
  unsnooze [claude args...]        run claude under limit-watch (default)
  unsnooze status                  list tracked sessions + reset countdowns
  unsnooze resume-now [id|--all]   resume stopped session(s) immediately
  unsnooze cancel [id|--all]       stop tracking session(s)
  unsnooze logs [-f]               show (or follow) the unsnooze log
  unsnooze install [--yes]         wire up zsh wrapper + Claude Code hook
  unsnooze uninstall [--purge]     remove wrapper + hook (and state with --purge)`);
      return 0;
    }
    default: {
      // Everything else (including no args, --resume, -c, plain prompts) is a
      // claude invocation.
      const { runLauncher } = await import('../src/launcher.js');
      const args = cmd === undefined ? [] : [cmd, ...rest];
      return runLauncher(args);
    }
  }
}

main().then(code => { process.exitCode = typeof code === 'number' ? code : 0; })
  .catch(err => { console.error(`unsnooze: ${err.stack || err}`); process.exitCode = 1; });
