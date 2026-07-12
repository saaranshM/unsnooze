// Desktop / terminal notifications — fire-and-forget, zero deps, never blocks
// or throws (detection and resume paths must not care whether a notifier exists).
//
// Channels (notifyChannel / opts.channel):
//   native — OS toast (osascript / notify-send / powershell) + tmux display-message
//   osc    — OSC 9/777 to client ttys (force); native fallback if 0 deliveries
//   bell   — BEL to pane tty; native fallback if undeliverable
//   auto   — OSC (detection-gated) + BEL when pane-capable; native only if OSC
//            delivered 0 (avoids double banners). Without pane context → native.
//
// notifications=false remains the master off-switch.

import { spawn } from 'node:child_process';
import { release as osRelease } from 'node:os';
import { getConfig } from './settings.js';
import { getMultiplexer } from './multiplexer.js';
import { sendOsc as defaultSendOsc, sendBell as defaultSendBell } from './notify-tty.js';

function defaultSpawner(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => { /* notifier missing — silently drop */ });
  child.unref();
}

function appleScriptString(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function isWsl(platform = process.platform, release = osRelease()) {
  return platform === 'linux' && /microsoft/i.test(release);
}

// Windows toast without any module: raise it through PowerShell's own AppId
// (unregistered AppIds get their toasts dropped on recent Windows builds).
const PS_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

function powershellToast(spawner, title, message) {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(message)}</text></binding></visual></toast>`;
  const script = [
    `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;`,
    `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument;`,
    `$xml.LoadXml('${xml.replace(/'/g, "''")}');`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${PS_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($xml));`,
  ].join(' ');
  spawner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

const CHANNELS = new Set(['auto', 'native', 'osc', 'bell']);

/**
 * Platform native notification (OS toast / tmux status-line fallback).
 * Body unchanged from the original notify() platform switch.
 */
export function nativeNotify(title, message, {
  platform = process.platform,
  wsl = isWsl(platform),
  spawner = defaultSpawner,
} = {}) {
  const mux = process.env.UNSNOOZE_MUX
    || (process.env.ZELLIJ ? 'zellij' : (process.env.TMUX ? 'tmux' : null));
  if (platform === 'darwin') {
    spawner('osascript', ['-e',
      `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`]);
  } else if (platform === 'win32' || wsl) {
    powershellToast(spawner, title, message);
  } else if (platform === 'linux') {
    spawner('notify-send', ['-a', 'unsnooze', title, message]);
  // Zellij has no statusline-inject equivalent, so its fallback is intentionally a no-op.
  } else if (mux === 'tmux' && process.env.TMUX) {
    spawner('tmux', ['display-message', `${title}: ${message}`]);
  }
}

function resolveChannel(channel) {
  if (channel != null) {
    return CHANNELS.has(channel) ? channel : 'auto';
  }
  try {
    const c = getConfig('notifyChannel');
    return CHANNELS.has(c) ? c : 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * True when we can attempt OSC/BEL: pane context + mux backend with clientTtys
 * (tmux). Zellij and other backends without clientTtys are not capable.
 */
function resolveCapableBackend(context, getMux) {
  if (!context || !context.pane) return null;
  if (!context.mux) return null;
  let backend;
  try {
    backend = getMux(context.mux, { owner: context.paneOwner ?? null });
  } catch {
    return null;
  }
  if (!backend || typeof backend.clientTtys !== 'function') return null;
  return backend;
}

export function notify(title, message, {
  platform = process.platform,
  wsl = isWsl(platform),
  spawner = defaultSpawner,
  context = null,
  channel = null,
  tty = { sendOsc: defaultSendOsc, sendBell: defaultSendBell },
  getMux = getMultiplexer,
} = {}) {
  try {
    if (!getConfig('notifications')) return;

    const nativeOpts = { platform, wsl, spawner };
    const fireNative = () => nativeNotify(title, message, nativeOpts);

    const ch = resolveChannel(channel);
    if (ch === 'native') {
      fireNative();
      return;
    }

    const backend = resolveCapableBackend(context, getMux);
    if (!backend) {
      // No pane context, unknown mux, or backend without clientTtys → native sync.
      fireNative();
      return;
    }

    const pane = context.pane;
    const sendOsc = tty?.sendOsc ?? defaultSendOsc;
    const sendBell = tty?.sendBell ?? defaultSendBell;

    if (ch === 'osc') {
      Promise.resolve()
        .then(async () => {
          let n = 0;
          try {
            n = await sendOsc(title, message, { mux: backend, pane, force: true });
          } catch { /* treat as undeliverable */ }
          if (n === 0) fireNative();
        })
        .catch(() => {});
      return;
    }

    if (ch === 'bell') {
      Promise.resolve()
        .then(async () => {
          let ok = false;
          try {
            ok = await sendBell({ mux: backend, pane });
          } catch { /* treat as undeliverable */ }
          if (!ok) fireNative();
        })
        .catch(() => {});
      return;
    }

    // auto: OSC (detection-gated) + BEL; native only if OSC delivered 0.
    Promise.resolve()
      .then(async () => {
        let n = 0;
        try {
          n = await sendOsc(title, message, { mux: backend, pane, force: false });
        } catch { /* treat as undeliverable */ }
        try {
          await sendBell({ mux: backend, pane });
        } catch { /* BEL is best-effort alongside OSC */ }
        if (n === 0) fireNative();
      })
      .catch(() => {});
  } catch { /* never let a notification break the caller */ }
}
