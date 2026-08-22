// Live full-screen dashboard — alternate screen until q / Ctrl+C.
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { MOUSE_DISABLE_ALL } from './mouse-protocol.js';
import { getConfig } from '../settings.js';

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
  const writeDisable = () => {
    try { stdout.write(MOUSE_DISABLE_ALL); } catch { /* stream gone */ }
  };
  const off = () => {
    if (done) return;
    done = true;
    writeDisable();
  };
  const onExit = () => off();
  // process.exit() here routes through signal-exit's patched reallyExit
  // (installed by Ink), which runs Ink's unmount — restoring the alt-screen —
  // before the process actually terminates. Fragile coupling: if Ink ever
  // stops patching reallyExit, exit() would terminate before unmount runs.
  const onSignal = (sig) => () => {
    off();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  const onInt = onSignal('SIGINT');
  const onTerm = onSignal('SIGTERM');
  const onTstp = () => {
    // Write mouse-off before ink suspends; MouseProvider re-enables on SIGCONT.
    // Bypasses the `done` gate intentionally: SIGTSTP can fire repeatedly
    // (stop/cont/stop) across a single process lifetime, unlike exit/INT/TERM.
    writeDisable();
    // Installing a SIGTSTP listener removes Node's default stop disposition,
    // so an external `kill -TSTP` would otherwise no-op instead of suspending
    // the process. Re-raise with SIGSTOP (uncatchable) to restore that
    // behavior; SIGCONT resume re-enables the mouse via the provider's
    // existing handler.
    if (process.platform !== 'win32') process.kill(process.pid, 'SIGSTOP');
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

// React's development build records a `performance.measure()` entry for every
// render, commit and setState — the React Performance Track it publishes for
// devtools. Node buffers user-timing entries and nothing ever drains that
// buffer, so on a long-lived dashboard it IS the leak: the status tab repaints
// roughly three times a second (a 1s data tick plus the 450ms logo animation),
// each repaint leaves ~40 entries behind, and an overnight `unsnooze status`
// walked into Node's 2GB heap ceiling and aborted (#16). Measured at ~12 kB
// retained per render, surviving a forced GC.
//
// The entries cannot be capped (Node caps resource timing, not user timing) and
// switching React to its production build would mean setting NODE_ENV for the
// whole CLI before anything imports React. Draining is the narrow fix: nothing
// in unsnooze reads user timing, and the sweep lives exactly as long as the
// render does.
export const TIMING_SWEEP_MS = 5_000;

export function sweepReactTiming(perf = globalThis.performance) {
  try {
    perf?.clearMeasures?.();
    perf?.clearMarks?.();
  } catch { /* a runtime with no user timing has nothing to leak */ }
}

// Returns the stop function. The timer is unref'd: draining a buffer is never
// a reason to hold the process open.
export function startTimingSweep({ intervalMs = TIMING_SWEEP_MS, perf } = {}) {
  sweepReactTiming(perf);
  const timer = setInterval(() => sweepReactTiming(perf), intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    sweepReactTiming(perf);
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
  const stopTimingSweep = startTimingSweep();
  try {
    const instance = render(h(App, { initialTab: tab, mouseEnabled: getConfig('mouse') !== false }), {
      exitOnCtrlC: true,
      // Full-screen: separate buffer like vim / htop / less — original scrollback restored on quit
      alternateScreen: true,
    });

    await instance.waitUntilExit();
  } finally {
    stopTimingSweep();
  }
  // Belt and braces: normal quit also clears modes (provider already did).
  process.stdout.write(MOUSE_DISABLE_ALL);
  return 0;
}

export async function cmdDashboard(args = []) {
  const tabArg = args.find(a => !a.startsWith('-'));
  const tab = ['status', 'usage', 'sessions', 'doctor', 'logs', 'fleet', 'prompts'].includes(tabArg)
    ? tabArg
    : 'status';
  return runDashboard({ tab });
}
