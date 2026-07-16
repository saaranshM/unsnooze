// Live full-screen dashboard — alternate screen until q / Ctrl+C.
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';

const h = React.createElement;

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

  const instance = render(h(App, { initialTab: tab }), {
    exitOnCtrlC: true,
    // Full-screen: separate buffer like vim / htop / less — original scrollback restored on quit
    alternateScreen: true,
  });

  await instance.waitUntilExit();
  return 0;
}

export async function cmdDashboard(args = []) {
  const tabArg = args.find(a => !a.startsWith('-'));
  const tab = ['status', 'usage', 'sessions', 'doctor', 'logs'].includes(tabArg)
    ? tabArg
    : 'status';
  return runDashboard({ tab });
}
