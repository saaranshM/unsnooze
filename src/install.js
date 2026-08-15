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
import { homedir, userInfo } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { CLAUDE_SETTINGS, STATE_DIR } from './config.js';
import { getConfig, configFileExists } from './settings.js';
import { xmlEscape } from './notify.js';
import { installGrokHooks, uninstallGrokHooks } from './agents/grok.js';
import { findCsgProcesses, findCsgAutostarts } from './doctor.js';
import { UNSNOOZE_BIN, stopResumer } from './spawn.js';
import { uninstallStatuslineShim } from './usage.js';
import { powershellProfilePath } from './powershell.js';

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

// Two backup tiers: `.unsnooze-orig` is the pristine pre-unsnooze snapshot,
// written exactly once (a re-run must never overwrite it with an already-
// modified file); `.unsnooze-bak` rolls forward on every run.
function backupOnce(path) {
  const orig = `${path}.unsnooze-orig`;
  if (!existsSync(orig)) copyFileSync(path, orig);
  copyFileSync(path, `${path}.unsnooze-bak`);
}

// --- settings.json hook management ---

function isOurs(entry) {
  return (entry.hooks || []).some(h => /unsnooze\.js"? _hook-stopfailure/.test(h.command || ''));
}
function isLegacy(entry) {
  return (entry.hooks || []).some(h => /claude-auto-retry|csg\.js _hook-stopfailure/.test(h.command || ''));
}

// The StopFailure hook command, per platform.
//
// Guarded like the shell wrapper: a vanished entry point must exit 0, not
// spray MODULE_NOT_FOUND errors into every Claude Code turn. The guard has to
// be written in the shell that will actually run it — Claude Code runs hooks
// through cmd.exe on native Windows, where `test` does not exist, so the POSIX
// form silently failed on every turn and took the hook detection channel with
// it. That mattered little while Windows had no multiplexer to watch with; it
// matters entirely now that headless leans on the hook.
export function hookCommand({ platform = process.platform, bin = UNSNOOZE_BIN, agent = null } = {}) {
  const agentFlag = agent ? ` --agent ${agent}` : '';
  if (platform === 'win32') {
    return `if exist "${bin}" (node "${bin}" _hook-stopfailure${agentFlag}) else (exit 0)`;
  }
  return `test -f "${bin}" && node "${bin}" _hook-stopfailure${agentFlag} || exit 0`;
}

// agent/matcher options cover CLIs with Claude-shaped hook config in their own
// settings.json (qwen); the default stays byte-identical for claude.
export function mergeHookIntoSettings(settingsJson, {
  agent = null,
  matcher = 'overloaded|server_error|rate_limit',
  platform = process.platform,
} = {}) {
  const settings = JSON.parse(settingsJson);
  settings.hooks = settings.hooks || {};
  const list = (settings.hooks.StopFailure || []).filter(e => !isLegacy(e) && !isOurs(e));
  list.push({
    matcher,
    hooks: [{ type: 'command', command: hookCommand({ platform, agent }), timeout: 5 }],
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

// The PowerShell twin of wrapperBlock(), for native Windows where there is no
// ~/.zshrc or ~/.bashrc to put a function in. Nobody types `unsnooze claude` —
// the wrapper shadowing the real CLI *is* the entry point, so without this
// nothing on native Windows routes through unsnooze at all.
//
// PowerShell comments are `#`, so the same fence markers work and
// stripFencedBlock() removes it unchanged.
export function powershellWrapperBlock(agents = ['claude'], bin = UNSNOOZE_BIN) {
  const fns = agents.map(id => `Remove-Item -Path Alias:${id} -Force -ErrorAction SilentlyContinue
function ${id} {
  if ($env:UNSNOOZE_ACTIVE -eq '1' -or -not (Test-Path -LiteralPath '${bin}')) {
    $real = Get-Command ${id} -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($real) { & $real.Source @args } else { Write-Error '${id}: not found' }
    return
  }
  & node '${bin}' _run ${id} @args
}`).join('\n');
  return `${FENCE_OPEN}
# unsnooze wrappers: route every interactive launch of the CLIs below through
# unsnooze so limit stops are recorded and auto-resumed.
${fns}
${FENCE_CLOSE}`;
}

// installZshrcBlock's PowerShell twin. Same fence, same replace-don't-append
// behaviour, so re-running setup never stacks a second copy of the wrappers.
export function installPowershellBlock(content, agents = ['claude'], bin = UNSNOOZE_BIN) {
  const { content: cleaned } = stripFencedBlock(content, FENCE_OPEN, FENCE_CLOSE);
  return cleaned.replace(/\n+$/, '\n') + '\n' + powershellWrapperBlock(agents, bin) + '\n';
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
// Task Scheduler has no reverse-DNS convention and shows this name to the user
// in taskschd.msc, so it is a plain word rather than the launchd label.
export const WINDOWS_TASK_NAME = 'unsnooze';

// Is this process running under the supervisor we install, rather than from
// somebody's shell? It decides whether exiting is safe: a supervised daemon
// that exits on version skew comes straight back on fresh code, while an
// unsupervised one exits into nothing and GUI watching stops silently.
//
// Both markers are injected by the supervisor itself and were read off real
// processes rather than inferred: launchd sets XPC_SERVICE_NAME to the job
// label for its jobs (an interactive shell reports the literal '0'), and
// systemd sets a per-invocation INVOCATION_ID for every unit it starts.
// Matching the exact label, not merely "some launchd job", keeps an unrelated
// XPC service from being mistaken for our supervisor.
export function isSupervised({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') return env.XPC_SERVICE_NAME === DAEMON_LABEL;
  if (platform === 'linux') return typeof env.INVOCATION_ID === 'string' && env.INVOCATION_ID !== '';
  // win32 stays false on purpose, even though we now install a Scheduled Task.
  // launchd KeepAlive and systemd Restart=always bring the daemon straight
  // back; a logon-triggered task does not restart anything until the next
  // logon. Answering true here would let the version-skew guard exit 0 into
  // nothing and stop Windows watching silently — the exact failure mode of
  // issue #8, just with a different trigger. The cost is that a Windows daemon
  // keeps running pre-upgrade code until the user logs back in; that is the
  // lesser of the two, and `unsnooze doctor` reports the skew.
  return false;
}

// Env overrides keep tests/e2e away from the real LaunchAgents / systemd dirs.
function autostartDir(platform) {
  if (platform === 'darwin') {
    return process.env.UNSNOOZE_LAUNCH_AGENTS_DIR || join(homedir(), 'Library', 'LaunchAgents');
  }
  return process.env.UNSNOOZE_SYSTEMD_USER_DIR || join(homedir(), '.config', 'systemd', 'user');
}

// The one place that knows what our unit file is called on each platform.
export function autostartUnitPath({ platform = process.platform, dir = null } = {}) {
  const base = dir || autostartDir(platform);
  if (platform === 'darwin') return join(base, `${DAEMON_LABEL}.plist`);
  if (platform === 'linux') return join(base, 'unsnooze.service');
  return null;
}

// Can this PATH string actually find `bin`? The daemon reaches tmux through
// PATH (`execFile('tmux', …)`), so a unit whose baked PATH fails this test
// cannot revive anything — every call dies with ENOENT. Pure and synchronous
// on purpose: this decides whether to rewrite-and-reload a unit, and that
// decision must be deterministic.
// `sep` defaults to the host's PATH delimiter, not a hardcoded ':'. On Windows
// that is ';' AND every absolute path contains a colon (C:\...), so splitting
// on ':' shreds the entries into nonsense. The units we inspect are always
// POSIX, but this predicate has to give an honest answer wherever it runs.
export function pathResolves(pathStr, bin, { sep = delimiter } = {}) {
  if (typeof pathStr !== 'string' || pathStr === '') return false;
  return pathStr.split(sep).some(d => d && existsSync(join(d, bin)));
}

function xmlUnescape(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// The PATH a unit currently bakes in, or null when it bakes none.
function bakedUnitPath(content, platform) {
  if (platform === 'darwin') {
    const m = content.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/);
    return m ? xmlUnescape(m[1]) : null;
  }
  const m = content.match(/^Environment="PATH=(.*)"$/m);
  return m ? m[1].replace(/%%/g, '%') : null;
}

function defaultLoginPathRunner(cmd, args, opts) {
  return execFileSync(cmd, args, opts);
}

// Ask the user's login shell what PATH it builds. This exists because the only
// caller of the self-heal is the daemon itself, and a daemon's PATH is the
// launchd/systemd minimal one — the very thing being repaired. Reading
// process.env.PATH there just writes the breakage back.
//
// PATH is stripped from the child env so the login files construct it fresh
// rather than appending to the broken value we inherited. Failure returns null:
// a bad guess is worse than leaving the unit alone.
export function resolveLoginPath({
  shell = process.env.SHELL || userInfo().shell,
  runner = defaultLoginPathRunner,
  timeoutMs = 3000,
} = {}) {
  if (!shell) return null;
  try {
    const { PATH, ...env } = process.env;   // eslint-disable-line no-unused-vars
    const out = runner(shell, ['-lc', 'echo $PATH'], {
      encoding: 'utf-8', timeout: timeoutMs, env, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const path = String(out || '').trim();
    return path || null;
  } catch {
    return null;   // no shell, slow rc files, non-zero exit — all "no answer"
  }
}

// The best PATH we can offer a unit: the caller's own if it already finds the
// binary (the `unsnooze setup`-from-a-shell case), otherwise whatever the login
// shell reports. null means we have nothing better to write.
function bestUnitPath({ currentPath, resolvePath, muxBin }) {
  if (pathResolves(currentPath, muxBin)) return currentPath;
  const fresh = resolvePath();
  return fresh && pathResolves(fresh, muxBin) ? fresh : null;
}

export function launchdPlist({
  nodeBin = process.execPath, unsnoozeBin = UNSNOOZE_BIN,
  logFile = join(STATE_DIR, 'daemon.log'),
  path = process.env.PATH || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
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
  <!-- launchd default PATH is /usr/bin:/bin:/usr/sbin:/sbin — tmux (usually
       /opt/homebrew/bin or /usr/local/bin) is invisible to the daemon and
       every revival dies with spawn ENOENT. Bake the install-time PATH. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(path)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Without a throttle, KeepAlive + a half-installed package (npm -g
       upgrade window) = instant-respawn crash-loop into the log. -->
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logFile)}</string>
</dict>
</plist>
`;
}

export function systemdUnit({
  nodeBin = process.execPath, unsnoozeBin = UNSNOOZE_BIN,
  path = process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
} = {}) {
  // Restart=always, not on-failure: the version-skew guard and the
  // upgrade-window fail-safe exit 0 EXPECTING a respawn on fresh code.
  // RestartSec throttles (like launchd's ThrottleInterval); the start
  // rate-limit is disabled so a long broken-install window can never trip
  // the unit into a permanent 'failed' state. Environment PATH mirrors the
  // launchd fix — user units get a minimal PATH that may not find tmux.
  // systemd treats % as a specifier — escape as %%.
  return `[Unit]
Description=unsnooze daemon — watches GUI AI-coding sessions for limit stops
StartLimitIntervalSec=0

[Service]
ExecStart="${nodeBin}" "${unsnoozeBin}" daemon
Environment="PATH=${path.replace(/%/g, '%%')}"
Restart=always
RestartSec=30

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

export function installDaemonAutostart({
  platform = process.platform, dir = null, activate = defaultActivate, path = undefined,
} = {}) {
  // Native Windows has no unit *file* — the Task Scheduler holds the record —
  // so it is handled before the file-based platforms below. It matters more
  // here than anywhere else: the transcript watcher lives in the daemon, and
  // headless has no pane monitor to fall back on, so without this a Windows
  // machine only ever catches limit stops through the StopFailure hook.
  if (platform === 'win32') {
    // /f overwrites an existing task rather than failing with "already exists",
    // which is what re-running setup does every time.
    activate('schtasks', ['/create', '/f', '/tn', WINDOWS_TASK_NAME, '/sc', 'onlogon',
      '/tr', `"${process.execPath}" "${UNSNOOZE_BIN}" daemon`]);
    return `Scheduled Task \\${WINDOWS_TASK_NAME}`;
  }
  const target = autostartUnitPath({ platform, dir });
  if (!target) return null;
  // Safety interlock. Every unit we generate carries the SAME label, so running
  // the real launchctl/systemctl against a unit written somewhere else (a test
  // fixture, a staging copy) does not create a second job — it HIJACKS the
  // user's live one, leaving it pointed at a directory that may not outlive the
  // caller. So the real activator only ever runs for the unit path this
  // platform actually uses; an injected activator is always honored, since a
  // caller that supplied one has said what it wants to happen.
  const act = (activate === defaultActivate && target !== autostartUnitPath({ platform }))
    ? () => true
    : activate;
  if (platform === 'darwin') {
    atomicWrite(target, launchdPlist(path ? { path } : {}));
    act('launchctl', ['unload', target]);   // reload cleanly if already loaded
    act('launchctl', ['load', '-w', target]);
    return target;
  }
  atomicWrite(target, systemdUnit(path ? { path } : {}));
  act('systemctl', ['--user', 'daemon-reload']);
  act('systemctl', ['--user', 'enable', '--now', 'unsnooze.service']);
  return target;
}

// One-time self-heal for units written before 1.12.0: they carry no PATH, so
// the daemon cannot find tmux (launchd gives daemons /usr/bin:/bin:… only) and
// every revival dies with spawn ENOENT. npm updates never touch the unit file,
// so the daemon repairs it on startup: regenerate + reload. Reloading kills
// the calling daemon — by design; the supervisor restarts it under the fixed
// unit. Returns the healed target, or null when nothing needed healing.
// Does an installed unit bake a PATH that cannot reach the multiplexer? This
// is invisible from a user's shell — `doctor` finds tmux on the rich PATH it
// inherited and calls the install healthy — so the daemon's OWN baked PATH has
// to be inspected directly. Returns null when there is nothing to report
// (no unit, no baked PATH, or a PATH that works).
export function daemonPathBroken({ platform = process.platform, dir = null, muxBin = 'tmux' } = {}) {
  const unit = autostartUnitPath({ platform, dir });
  if (!unit || !existsSync(unit)) return null;   // not a daemon-autostart user
  let content;
  try { content = readFileSync(unit, 'utf-8'); } catch { return null; }
  const baked = bakedUnitPath(content, platform);
  if (baked == null || pathResolves(baked, muxBin)) return null;
  return { unit, path: baked, muxBin };
}

export function healDaemonAutostart({
  platform = process.platform, dir = null, activate = defaultActivate,
  resolvePath = resolveLoginPath, muxBin = 'tmux',
  currentPath = process.env.PATH || '',
} = {}) {
  const target = autostartUnitPath({ platform, dir });
  if (!target || !existsSync(target)) return null;   // not a daemon-autostart user
  let content;
  try { content = readFileSync(target, 'utf-8'); } catch { return null; }

  const marker = platform === 'darwin' ? 'EnvironmentVariables' : 'Environment="PATH=';
  const better = bestUnitPath({ currentPath, resolvePath, muxBin });

  // Pre-1.12 unit: no PATH at all. Always worth healing — but prefer a PATH
  // that actually works over the caller's, which is minimal when (as always)
  // the caller is the daemon.
  if (!content.includes(marker)) {
    return installDaemonAutostart({ platform, dir, activate, path: better || currentPath });
  }

  // Present but useless. This is the trap the original heal fell into: run
  // from the daemon, it baked the daemon's own tmux-less PATH back in, and the
  // marker being present then made it "already current" forever.
  const baked = bakedUnitPath(content, platform);
  if (baked == null || pathResolves(baked, muxBin)) return null;   // genuinely fine

  // CRASH-LOOP GUARD. Healing reloads the unit, which kills this daemon; the
  // supervisor restarts it and we arrive here again. Rewriting without a
  // strictly better PATH would repeat every 30s forever, which is worse than
  // the bug. No improvement available → leave it exactly as it is.
  if (!better || better === baked) return null;
  return installDaemonAutostart({ platform, dir, activate, path: better });
}

export function uninstallDaemonAutostart({ platform = process.platform, dir = null, activate = defaultActivate } = {}) {
  if (platform === 'win32') {
    // /f so a missing task is not an interactive prompt on an uninstall path.
    activate('schtasks', ['/delete', '/f', '/tn', WINDOWS_TASK_NAME]);
    return `Scheduled Task \\${WINDOWS_TASK_NAME}`;
  }
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
      backupOnce(opts.settings);
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
    if (existsSync(rc)) backupOnce(rc);
    const { content, oldRemoved } = installZshrcBlock(rcContent, agents);
    atomicWrite(rc, content);
    console.log(`unsnooze: wrappers (${agents.join(', ')}) installed in ${rc}${oldRemoved ? ' (legacy wrapper block removed)' : ''}`);
  }

  // 3b. PowerShell profile (native Windows). The rc loop above only ever
  //     reaches ~/.zshrc and ~/.bashrc, which a PowerShell user does not have —
  //     without this nothing routes their `claude` through unsnooze at all.
  const psProfile = powershellProfilePath();
  if (psProfile) {
    try {
      mkdirSync(dirname(psProfile), { recursive: true });
      const before = existsSync(psProfile) ? readFileSync(psProfile, 'utf-8') : '';
      if (existsSync(psProfile)) backupOnce(psProfile);
      atomicWrite(psProfile, installPowershellBlock(before, agents, UNSNOOZE_BIN));
      console.log(`unsnooze: PowerShell wrappers (${agents.join(', ')}) installed in ${psProfile}`);
    } catch (err) {
      console.log(`unsnooze: could not write the PowerShell profile (${err.message})`);
    }
  }

  // 4. Daemon autostart (GUI-session watching), opt-in via --daemon / wizard.
  if (opts.daemon) {
    const target = installDaemonAutostart();
    if (target) console.log(`unsnooze: daemon autostart installed (${target}) — GUI sessions are watched`);
    else console.log('unsnooze: daemon autostart is not supported on this platform');
  }

  // 5. Migration sweep: an upgrade from the pre-release csg leaves its
  //    monitors/daemon/state behind (npm cannot clean up a renamed package) —
  //    surface it right where upgraders will see it. Detection only; the
  //    actual retirement is `unsnooze doctor --fix`, one explicit step away.
  try {
    const legacy = findCsgProcesses().length > 0
      || findCsgAutostarts().length > 0
      || existsSync(join(homedir(), '.claude-session-guard'));
    if (legacy) {
      console.log('\nunsnooze: leftovers from the old claude-session-guard (csg) install detected.');
      console.log('unsnooze: run `unsnooze doctor --fix` to stop its processes and retire its files.');
    }
  } catch { /* detection is best-effort — never fail an install over it */ }

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

  // The PowerShell profile is a wrapper site too — leaving its block behind
  // would keep shadowing `claude` with a function pointing at a bin that
  // uninstall just removed.
  try {
    const psProfile = powershellProfilePath();
    if (psProfile && existsSync(psProfile)) {
      const { content, found } = stripFencedBlock(readFileSync(psProfile, 'utf-8'), FENCE_OPEN, FENCE_CLOSE);
      if (found) {
        atomicWrite(psProfile, content);
        console.log(`unsnooze: PowerShell wrappers removed from ${psProfile}`);
      }
    }
  } catch (err) {
    console.log(`unsnooze: could not clean the PowerShell profile (${err.message})`);
  }

  const autostart = uninstallDaemonAutostart();
  if (autostart) console.log(`unsnooze: daemon autostart removed (${autostart})`);

  // Restore Claude statusLine if our usage shim was chained in.
  try {
    const r = uninstallStatuslineShim({ settingsPath: opts.settings });
    if (r.removed) console.log('unsnooze: statusline usage shim removed');
  } catch (err) {
    console.log(`unsnooze: could not remove statusline shim (${err.message})`);
  }

  if (opts.purge) {
    rmSync(STATE_DIR, { recursive: true, force: true });
    console.log(`unsnooze: state dir ${STATE_DIR} removed`);
  }
  return 0;
}
