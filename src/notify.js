// Desktop notifications — fire-and-forget, zero deps, never blocks or throws
// (detection and resume paths must not care whether a notifier exists).
// macOS: osascript. Linux: notify-send. WSL & native Windows: powershell.exe
// toast (notify-send rarely exists inside WSL; powershell.exe always does).
// Fallback: tmux status-line message.

import { spawn } from 'node:child_process';
import { release as osRelease } from 'node:os';
import { getConfig } from './settings.js';

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

export function notify(title, message, {
  platform = process.platform,
  wsl = isWsl(platform),
  spawner = defaultSpawner,
} = {}) {
  try {
    if (!getConfig('notifications')) return;
    if (platform === 'darwin') {
      spawner('osascript', ['-e',
        `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`]);
    } else if (platform === 'win32' || wsl) {
      powershellToast(spawner, title, message);
    } else if (platform === 'linux') {
      spawner('notify-send', ['-a', 'unsnooze', title, message]);
    } else if (process.env.TMUX) {
      spawner('tmux', ['display-message', `${title}: ${message}`]);
    }
  } catch { /* never let a notification break the caller */ }
}
