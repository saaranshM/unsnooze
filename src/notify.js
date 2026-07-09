// Desktop notifications — fire-and-forget, zero deps, never blocks or throws
// (detection and resume paths must not care whether a notifier exists).
// macOS: osascript. Linux: notify-send. Fallback: tmux status-line message.

import { spawn } from 'node:child_process';
import { getConfig } from './settings.js';

function defaultSpawner(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => { /* notifier missing — silently drop */ });
  child.unref();
}

function appleScriptString(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function notify(title, message, { platform = process.platform, spawner = defaultSpawner } = {}) {
  try {
    if (!getConfig('notifications')) return;
    if (platform === 'darwin') {
      spawner('osascript', ['-e',
        `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`]);
    } else if (platform === 'linux') {
      spawner('notify-send', ['-a', 'unsnooze', title, message]);
    } else if (process.env.TMUX) {
      spawner('tmux', ['display-message', `${title}: ${message}`]);
    }
  } catch { /* never let a notification break the caller */ }
}
