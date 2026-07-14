// Install / uninstall: wires unsnooze into the shell and the agent CLIs, and
// migrates off claude-auto-retry / the pre-release csg.
//   - ~/.claude/settings.json: StopFailure hook → unsnooze _hook-stopfailure
//     (removes legacy hook entries; preserves everything else; backs up first;
//     atomic write)
//   - ~/.zshrc + ~/.bashrc: one fence-marked block with a wrapper function per
//     enabled agent (claude/codex/grok), routed through `unsnooze _run`
//   - ~/.grok/hooks/unsnooze.json when the grok agent is enabled
// --settings <path> / --zshrc <path> override targets (used by tests).

import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, rmSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { CLAUDE_SETTINGS, STATE_DIR } from './config.js';
import { getConfig, configFileExists } from './settings.js';
import { xmlEscape } from './notify.js';
import { installGrokHooks, uninstallGrokHooks } from './agents/grok.js';
import { UNSNOOZE_BIN, stopResumer } from './spawn.js';

const FENCE_OPEN = '# >>> unsnooze >>>';
const FENCE_CLOSE = '# <<< unsnooze <<<';
// Fenced blocks left by tools this one replaces: claude-auto-retry, and the
// pre-release "claude-session-guard" (csg) incarnation of unsnooze itself.
const LEGACY_FENCES = [
  { open: '# >>> claude-auto-retry >>>', close: '# <<< claude-auto-retry <<<' },
  { open: '# >>> claude-session-guard >>>', close: '# <<< claude-session-guard <<<' },
];
const OLD_FENCE_OPEN = LEGACY_FENCES[0].open;

function parseArgs(rest) {
  const opts = { yes: false, settings: CLAUDE_SETTINGS, zshrc: join(homedir(), '.zshrc'), purge: false, daemon: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--yes' || rest[i] === '-y') opts.yes = true;
    else if (rest[i] === '--purge') opts.purge = true;
    else if (rest[i] === '--daemon') opts.daemon = true;
    else if (rest[i] === '--settings') opts.settings = rest[++i];
    else if (rest[i] === '--zshrc') opts.zshrc = rest[++i];
  }
  return opts;
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });   // e.g. ~/.claude may not exist yet
  const tmp = join(dirname(path), `.${Date.now()}.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// --- settings.json hook management ---

function isOurs(entry) {
  return (entry.hooks || []).some(h => /unsnooze\.js"? _hook-stopfailure/.test(h.command || ''));
}
function isLegacy(entry) {
  return (entry.hooks || []).some(h => /claude-auto-retry|csg\.js _hook-stopfailure/.test(h.command || ''));
}

// agent/matcher options cover CLIs with Claude-shaped hook config in their own
// settings.json (qwen); the default stays byte-identical for claude.
export function mergeHookIntoSettings(settingsJson, { agent = null, matcher = 'overloaded|server_error|rate_limit' } = {}) {
  const settings = JSON.parse(settingsJson);
  settings.hooks = settings.hooks || {};
  const list = (settings.hooks.StopFailure || []).filter(e => !isLegacy(e) && !isOurs(e));
  const agentFlag = agent ? ` --agent ${agent}` : '';
  list.push({
    matcher,
    // Guarded like the shell wrapper: a vanished entry point must exit 0, not
    // spray MODULE_NOT_FOUND errors into every Claude Code turn.
    hooks: [{ type: 'command', command: `test -f "${UNSNOOZE_BIN}" && node "${UNSNOOZE_BIN}" _hook-stopfailure${agentFlag} || exit 0`, timeout: 5 }],
  });
  settings.hooks.StopFailure = list;
  return JSON.stringify(settings, null, 2) + '\n';
}

export function removeHookFromSettings(settingsJson) {
  const settings = JSON.parse(settingsJson);
  if (settings.hooks?.StopFailure) {
    settings.hooks.StopFailure = settings.hooks.StopFailure.filter(e => !isOurs(e));
    if (settings.hooks.StopFailure.length === 0) delete settings.hooks.StopFailure;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  return JSON.stringify(settings, null, 2) + '\n';
}

// --- zshrc block management ---

export function wrapperBlock(agents = ['claude']) {
  // The missing-file guard is load-bearing: if unsnooze is ever uninstalled,
  // moved, or renamed without cleaning the rc file, the wrapper must degrade
  // to the plain CLI — never brick the user's `claude`/`codex` command.
  const fns = agents.map(id => `unalias ${id} 2>/dev/null || true
${id}() {
  if [ "\${UNSNOOZE_ACTIVE}" = "1" ] || [ ! -f "${UNSNOOZE_BIN}" ]; then
    command ${id} "$@"
    return $?
  fi
  node "${UNSNOOZE_BIN}" _run ${id} "$@"
}`).join('\n');
  return `${FENCE_OPEN}
# unsnooze wrappers: route every interactive launch of the CLIs below through
# unsnooze so limit stops are recorded and auto-resumed.
${fns}
${FENCE_CLOSE}`;
}

export function stripFencedBlock(content, open, close) {
  const lines = content.split('\n');
  const out = [];
  let inside = false;
  let found = false;
  for (const line of lines) {
    if (!inside && line.trim() === open) { inside = true; found = true; continue; }
    if (inside && line.trim() === close) { inside = false; continue; }
    if (!inside) out.push(line);
  }
  return { content: out.join('\n'), found };
}

export function installZshrcBlock(content, agents = ['claude']) {
  let cleaned = content;
  let oldRemoved = false;
  for (const { open, close } of LEGACY_FENCES) {
    const r = stripFencedBlock(cleaned, open, close);
    cleaned = r.content;
    oldRemoved = oldRemoved || r.found;
  }
  ({ content: cleaned } = stripFencedBlock(cleaned, FENCE_OPEN, FENCE_CLOSE));
  const result = cleaned.replace(/\n+$/, '\n') + '\n' + wrapperBlock(agents) + '\n';
  return { content: result, oldRemoved };
}

// --- daemon autostart ---
// GUI sessions (VS Code extension, desktop apps) never pass through the shell
// wrappers, so their limit stops are only caught while `unsnooze daemon` is
// alive. Autostart keeps it alive: a launchd user agent on macOS, a systemd
// user unit on Linux/WSL.

export const DAEMON_LABEL = 'com.unsnooze.daemon';

// Env overrides keep tests/e2e away from the real LaunchAgents / systemd dirs.
function autostartDir(platform) {
  if (platform === 'darwin') {
    return process.env.UNSNOOZE_LAUNCH_AGENTS_DIR || join(homedir(), 'Library', 'LaunchAgents');
  }
  return process.env.UNSNOOZE_SYSTEMD_USER_DIR || join(homedir(), '.config', 'systemd', 'user');
}

export function launchdPlist({
  nodeBin = process.execPath, unsnoozeBin = UNSNOOZE_BIN,
  logFile = join(STATE_DIR, 'daemon.log'),
} = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(unsnoozeBin)}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logFile)}</string>
</dict>
</plist>
`;
}

export function systemdUnit({ nodeBin = process.execPath, unsnoozeBin = UNSNOOZE_BIN } = {}) {
  return `[Unit]
Description=unsnooze daemon — watches GUI AI-coding sessions for limit stops

[Service]
ExecStart="${nodeBin}" "${unsnoozeBin}" daemon
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

function defaultActivate(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;   // best-effort: the file is in place; a reboot/login loads it
  }
}

export function installDaemonAutostart({ platform = process.platform, dir = null, activate = defaultActivate } = {}) {
  if (platform === 'darwin') {
    const target = join(dir || autostartDir(platform), `${DAEMON_LABEL}.plist`);
    atomicWrite(target, launchdPlist());
    activate('launchctl', ['unload', target]);   // reload cleanly if already loaded
    activate('launchctl', ['load', '-w', target]);
    return target;
  }
  if (platform === 'linux') {
    const target = join(dir || autostartDir(platform), 'unsnooze.service');
    atomicWrite(target, systemdUnit());
    activate('systemctl', ['--user', 'daemon-reload']);
    activate('systemctl', ['--user', 'enable', '--now', 'unsnooze.service']);
    return target;
  }
  return null;   // native Windows: no supported multiplexer to revive into
}

export function uninstallDaemonAutostart({ platform = process.platform, dir = null, activate = defaultActivate } = {}) {
  if (platform === 'darwin') {
    const target = join(dir || autostartDir(platform), `${DAEMON_LABEL}.plist`);
    if (!existsSync(target)) return null;
    activate('launchctl', ['unload', target]);
    try { unlinkSync(target); } catch { /* already gone */ }
    return target;
  }
  if (platform === 'linux') {
    const target = join(dir || autostartDir(platform), 'unsnooze.service');
    if (!existsSync(target)) return null;
    activate('systemctl', ['--user', 'disable', '--now', 'unsnooze.service']);
    try { unlinkSync(target); } catch { /* already gone */ }
    return target;
  }
  return null;
}

// --- commands ---

export function enabledAgents() {
  return ['claude', 'codex', 'grok', 'qwen', 'kimi', 'opencode', 'agy'].filter(id => getConfig(`agents.${id}`));
}

// Qwen keeps Claude-shaped hooks in its own settings.json — reuse the same
// merge/remove machinery against ~/.qwen/settings.json. Matcher matches qwen's
// StopFailure `error` class; `unknown` is included because the discontinued
// free-tier message classifies as unknown, and hook.js's banner gate keeps
// unknowns without visible limit banners out of the ledger anyway.
const QWEN_HOOK_OPTS = { agent: 'qwen', matcher: 'rate_limit|unknown' };

function qwenSettingsPath() {
  return join(process.env.UNSNOOZE_QWEN_DIR || join(homedir(), '.qwen'), 'settings.json');
}

export function installQwenHooks() {
  const path = qwenSettingsPath();
  if (existsSync(path)) {
    copyFileSync(path, `${path}.unsnooze-bak`);
    atomicWrite(path, mergeHookIntoSettings(readFileSync(path, 'utf-8'), QWEN_HOOK_OPTS));
  } else {
    atomicWrite(path, mergeHookIntoSettings('{}', QWEN_HOOK_OPTS));
  }
  return path;
}

export function uninstallQwenHooks() {
  const path = qwenSettingsPath();
  if (!existsSync(path)) return null;
  atomicWrite(path, removeHookFromSettings(readFileSync(path, 'utf-8')));
  return path;
}

// rc files to touch: the explicit --zshrc target, or every rc file that exists
// (zsh + bash) so the wrappers work regardless of the user's shell.
function rcTargets(opts, explicit) {
  if (explicit) return [opts.zshrc];
  const candidates = [join(homedir(), '.zshrc'), join(homedir(), '.bashrc')];
  const existing = candidates.filter(p => existsSync(p));
  return existing.length > 0 ? existing : [opts.zshrc];
}

export function cmdInstall(rest, { agents = enabledAgents() } = {}) {
  const opts = parseArgs(rest);
  const explicitRc = rest.includes('--zshrc');

  // First run in a real terminal with no saved settings → hand over to the
  // interactive setup wizard (it calls back here with --yes afterwards).
  if (!opts.yes && !configFileExists() && process.stdout.isTTY && process.stdin.isTTY) {
    return import('./wizard.js').then(({ runWizard }) => runWizard());
  }

  // 1. Claude Code hook (also consumed by Grok Build's Claude-compatible hooks
  //    when installed below).
  if (agents.includes('claude')) {
    if (existsSync(opts.settings)) {
      copyFileSync(opts.settings, `${opts.settings}.unsnooze-bak`);
      const before = readFileSync(opts.settings, 'utf-8');
      atomicWrite(opts.settings, mergeHookIntoSettings(before));
      console.log(`unsnooze: StopFailure hook installed in ${opts.settings} (backup: ${opts.settings}.unsnooze-bak)`);
    } else {
      atomicWrite(opts.settings, mergeHookIntoSettings('{}'));
      console.log(`unsnooze: created ${opts.settings} with StopFailure hook`);
    }
  }

  // 2. Grok Build hook file.
  if (agents.includes('grok')) {
    const file = installGrokHooks({ unsnoozeBin: UNSNOOZE_BIN });
    console.log(`unsnooze: Grok StopFailure hook installed at ${file}`);
  }

  // 2b. Qwen Code hook (Claude-shaped hooks in ~/.qwen/settings.json).
  if (agents.includes('qwen')) {
    const file = installQwenHooks();
    console.log(`unsnooze: Qwen StopFailure hook installed in ${file}`);
  }

  // 3. Shell wrappers (zsh + bash).
  for (const rc of rcTargets(opts, explicitRc)) {
    const rcContent = existsSync(rc) ? readFileSync(rc, 'utf-8') : '';
    const hasOld = rcContent.includes(OLD_FENCE_OPEN) || rcContent.includes('CLAUDE_AUTO_RETRY_ACTIVE');
    if (hasOld && !opts.yes) {
      console.log(`unsnooze: found the old claude-auto-retry wrapper in ${rc}.`);
      console.log('unsnooze: re-run with --yes to replace it, or remove the fenced');
      console.log(`unsnooze: "${OLD_FENCE_OPEN}" block manually first.`);
      return 1;
    }
    if (existsSync(rc)) copyFileSync(rc, `${rc}.unsnooze-bak`);
    const { content, oldRemoved } = installZshrcBlock(rcContent, agents);
    atomicWrite(rc, content);
    console.log(`unsnooze: wrappers (${agents.join(', ')}) installed in ${rc}${oldRemoved ? ' (legacy wrapper block removed)' : ''}`);
  }

  // 4. Daemon autostart (GUI-session watching), opt-in via --daemon / wizard.
  if (opts.daemon) {
    const target = installDaemonAutostart();
    if (target) console.log(`unsnooze: daemon autostart installed (${target}) — GUI sessions are watched`);
    else console.log('unsnooze: daemon autostart is not supported on this platform');
  }

  console.log('\nunsnooze: done. Reload your shell:');
  console.log('  exec $SHELL');
  return 0;
}

export function cmdUninstall(rest) {
  const opts = parseArgs(rest);
  const explicitRc = rest.includes('--zshrc');

  // Stop the resumer/daemon first so it cannot keep writing state after hooks
  // are gone (zombie-daemon-running-deleted-code failure mode).
  try {
    const result = stopResumer();
    if (result.stopped) console.log(`unsnooze: resumer stopped (pid ${result.pid})`);
    else if (result.reason === 'stale') console.log('unsnooze: stale resumer lock cleared');
  } catch (err) {
    console.log(`unsnooze: could not stop resumer (${err.message})`);
  }

  if (existsSync(opts.settings)) {
    const before = readFileSync(opts.settings, 'utf-8');
    atomicWrite(opts.settings, removeHookFromSettings(before));
    console.log(`unsnooze: StopFailure hook removed from ${opts.settings}`);
  }

  uninstallGrokHooks();
  const qwenFile = uninstallQwenHooks();
  if (qwenFile) console.log(`unsnooze: StopFailure hook removed from ${qwenFile}`);

  for (const rc of rcTargets(opts, explicitRc)) {
    if (!existsSync(rc)) continue;
    const { content, found } = stripFencedBlock(readFileSync(rc, 'utf-8'), FENCE_OPEN, FENCE_CLOSE);
    if (found) {
      atomicWrite(rc, content);
      console.log(`unsnooze: wrappers removed from ${rc}`);
    }
  }

  const autostart = uninstallDaemonAutostart();
  if (autostart) console.log(`unsnooze: daemon autostart removed (${autostart})`);

  if (opts.purge) {
    rmSync(STATE_DIR, { recursive: true, force: true });
    console.log(`unsnooze: state dir ${STATE_DIR} removed`);
  }
  return 0;
}
