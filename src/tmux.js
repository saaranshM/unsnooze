import { execFile as execFileCb, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFileCb);

// Is tmux runnable at all? Used for a friendly error instead of a cryptic
// spawn failure (native Windows users get pointed at WSL).
export function tmuxAvailable() {
  try {
    return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

// Submit delay: text and the submitting Enter must be TWO separate send-keys
// calls with a pause between them, or Ink (Claude Code's TUI) treats the Enter
// as a newline inside a bracketed-paste burst instead of a submit.
export const SUBMIT_DELAY_MS = 150;

async function tmux(...args) {
  const { stdout } = await execFileAsync('tmux', args);
  return stdout;
}

export function insideTmux() { return !!process.env.TMUX; }
export function currentPaneId() { return process.env.TMUX_PANE || null; }

export async function capturePane(pane, lines = 200) {
  return tmux('capture-pane', '-t', pane, '-p', '-S', `-${lines}`);
}

// Type a message into a TUI and submit it (split form; -l sends literally so
// tmux key names inside the message are typed, not interpreted).
export async function sendText(pane, text) {
  await tmux('send-keys', '-t', pane, '-l', text);
  await new Promise(r => setTimeout(r, SUBMIT_DELAY_MS));
  await tmux('send-keys', '-t', pane, 'Enter');
}

// Single named key ('Down', 'Up', 'Enter', 'Escape') — drives menus.
export async function sendKey(pane, key) {
  await tmux('send-keys', '-t', pane, key);
}

export async function paneAlive(pane) {
  try {
    await tmux('display-message', '-t', pane, '-p', '#{pane_id}');
    return true;
  } catch {
    return false;
  }
}

export async function paneCurrentCommand(pane) {
  try {
    return (await tmux('display-message', '-t', pane, '-p', '#{pane_current_command}')).trim();
  } catch {
    return null;
  }
}

// NOTE: plain session names, not the '=name' exact-match prefix — tmux 3.7b
// rejects '=name' as a target here ("name not found" despite the session
// existing). Exact matches take priority over prefix matches anyway.
export async function sessionExists(name) {
  try {
    await tmux('has-session', '-t', name);
    return true;
  } catch {
    return false;
  }
}

// Open a new window in the named session (creating the session if needed),
// cd'd to cwd, running command. Returns the new pane id.
export async function newWindow(sessionName, cwd, command) {
  if (!(await sessionExists(sessionName))) {
    await tmux('new-session', '-d', '-s', sessionName, '-c', cwd);
    // The fresh session's first window IS our window — run the command there.
    const pane = (await tmux('display-message', '-t', sessionName, '-p', '#{pane_id}')).trim();
    await tmux('send-keys', '-t', pane, '-l', command);
    await tmux('send-keys', '-t', pane, 'Enter');
    return pane;
  }
  const out = await tmux('new-window', '-t', `${sessionName}:`, '-c', cwd, '-P', '-F', '#{pane_id}', command);
  return out.trim();
}
