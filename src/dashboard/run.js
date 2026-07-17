// Live full-screen dashboard — alternate screen until q / Ctrl+C.
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { MOUSE_DISABLE_ALL } from './mouse-protocol.js';

const h = React.createElement;

// The alt-screen reset does NOT clear mouse tracking modes — a crash or
// signal-kill without this leaves the user's shell with a hijacked mouse
// (the lazygit #1764 / opencode #26198 failure class). `exit` doesn't fire
// on signal default-kills and signal handlers don't cover process.exit(),
// so install both. Idempotent: only the first install registers.
let cleanupInstalled = false;
export function installMouseCleanup(stdout = process.stdout) {
  if (cleanupInstalled) return () => {};
  cleanupInstalled = true;
  let done = false;
  const off = () => {
    if (done) return;
    done = true;
    try { stdout.write(MOUSE_DISABLE_ALL); } catch { /* stream gone */ }
  };
  const onExit = () => off();
  const onSignal = (sig) => () => {
    off();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  const onInt = onSignal('SIGINT');
  const onTerm = onSignal('SIGTERM');
  const onTstp = () => {
    // Write mouse-off before ink suspends; MouseProvider re-enables on SIGCONT.
    try { stdout.write(MOUSE_DISABLE_ALL); } catch { /* stream gone */ }
  };
  process.on('exit', onExit);
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  process.on('SIGTSTP', onTstp);
  return () => {
    done = true;
    cleanupInstalled = false;
    process.off('exit', onExit);
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    process.off('SIGTSTP', onTstp);
  };
}

export function shouldUseDashboard({
  force = null,
  json = false,
  isTTY = process.stdout?.isTTY && process.stdin?.isTTY,
  env = process.env,
} = {}) {
  if (force === true) return true;
  if (force === false) return false;
  if (json) return false;
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return false;
  if (env.CI === 'true' || env.CI === '1') return false;
  if (env.TERM === 'dumb') return false;
  return !!isTTY;
}

export async function runDashboard({ tab = 'status' } = {}) {
  if (!shouldUseDashboard()) {
    console.error('unsnooze dashboard: requires an interactive TTY (not a pipe/CI).');
    // Still show the brand so users see the logo even when falling back
    const { logoPlainText } = await import('./Logo.js');
    console.error('\n' + logoPlainText() + '\n');
    return 1;
  }

  installMouseCleanup(process.stdout);
  const instance = render(h(App, { initialTab: tab }), {
    exitOnCtrlC: true,
    // Full-screen: separate buffer like vim / htop / less — original scrollback restored on quit
    alternateScreen: true,
  });

  await instance.waitUntilExit();
  // Belt and braces: normal quit also clears modes (provider already did).
  process.stdout.write(MOUSE_DISABLE_ALL);
  return 0;
}

export async function cmdDashboard(args = []) {
  const tabArg = args.find(a => !a.startsWith('-'));
  const tab = ['status', 'usage', 'sessions', 'doctor', 'logs'].includes(tabArg)
    ? tabArg
    : 'status';
  return runDashboard({ tab });
}
