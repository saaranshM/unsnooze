// `unsnooze doctor [--fix]` — health check + csg (claude-session-guard)
// migration sweep. npm has no successor mechanism and `-g` uninstall hooks are
// unreliable, so the ONLY robust cleanup of the pre-release csg install is
// unsnooze itself finding and retiring its leftovers: zombie csg monitors/
// resumers, an old launchd/systemd unit, the orphaned state dir, the stale
// global package. Everything is injectable for tests; --fix never deletes
// data (the state dir is archived) and never runs npm (hint only).

import { readFileSync, readdirSync, renameSync, existsSync, unlinkSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { CLAUDE_SETTINGS, RESUMER_LOCK } from './config.js';
import { getMultiplexer } from './multiplexer.js';
import { makeLogger } from './logger.js';
import { shouldUseTui, formatDoctorTui } from './tui.js';

const log = makeLogger('doctor');

const CSG_PROCESS_RE = /\bcsg\.js\s+_?(?:monitor|resumer|run|daemon|hook)/;
// A unit is csg-legacy when it execs csg.js, or mentions claude-session-guard
// WITHOUT execing unsnooze — the dev repo kept the old folder name after the
// rename, so a live unsnooze daemon plist can legitimately have
// .../claude-session-guard/bin/unsnooze.js in its path. Flagging that would
// let --fix destroy the running daemon.
function isCsgUnit(content) {
  if (/csg\.js/.test(content)) return true;
  return /claude-session-guard/.test(content) && !/unsnooze\.js|com\.unsnooze/.test(content);
}

function defaultRunner(cmd, args) {
  try {
    return spawnSync(cmd, args, { encoding: 'utf-8' });
  } catch (err) {
    return { status: 1, stdout: '', error: err };
  }
}

// --- detections ---------------------------------------------------------------

/** Live csg-era processes (monitors/resumers/daemons). */
export function findCsgProcesses({ runner = defaultRunner } = {}) {
  const r = runner('ps', ['-axo', 'pid=,command=']);
  if (r.error || r.status !== 0) return [];
  return String(r.stdout || '').split('\n')
    .map(line => line.trim())
    .filter(line => CSG_PROCESS_RE.test(line))
    .map(line => {
      const m = line.match(/^(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), command: m[2] } : null;
    })
    .filter(Boolean);
}

/** launchd plists / systemd units that exec csg (never the unsnooze one). */
export function findCsgAutostarts({ dir = defaultLaunchAgentsDir() } = {}) {
  try {
    return readdirSync(dir)
      .filter(name => name.endsWith('.plist') || name.endsWith('.service'))
      .map(name => join(dir, name))
      .filter(path => {
        try { return isCsgUnit(readFileSync(path, 'utf-8')); }
        catch { return false; }
      });
  } catch {
    return [];   // dir missing — nothing installed
  }
}

function defaultLaunchAgentsDir(platform = process.platform) {
  if (platform === 'darwin') {
    return process.env.UNSNOOZE_LAUNCH_AGENTS_DIR || join(homedir(), 'Library', 'LaunchAgents');
  }
  return process.env.UNSNOOZE_SYSTEMD_USER_DIR || join(homedir(), '.config', 'systemd', 'user');
}

// The stale global package. `command -v csg` is NOT enough: after the rename
// the repo has no bin/csg.js, so the global `csg` symlink dangles and shells
// skip it — but the package entry in node_modules is still there (often as an
// npm-link). lstat sees the entry even when the symlink target is gone.
export function defaultCsgPackagePath({
  runner = defaultRunner,
  execPathRoots = [join(dirname(dirname(process.execPath)), 'lib', 'node_modules')],
} = {}) {
  const roots = [];
  const r = runner('npm', ['root', '-g']);
  if (!r.error && r.status === 0 && r.stdout) roots.push(String(r.stdout).trim());
  roots.push(...execPathRoots);   // nvm/unix prefix layout fallback when npm is slow/absent
  for (const root of roots) {
    if (!root) continue;
    const candidate = join(root, 'claude-session-guard');
    try { lstatSync(candidate); return candidate; } catch { /* not here */ }
  }
  return null;
}

function defaultHookInstalled(settingsPath = CLAUDE_SETTINGS) {
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    return (settings.hooks?.StopFailure || []).some(entry =>
      (entry.hooks || []).some(h => /unsnooze\.js"? _hook-stopfailure/.test(h.command || '')));
  } catch {
    return false;
  }
}

function defaultWrappersInstalled() {
  return [join(homedir(), '.zshrc'), join(homedir(), '.bashrc')].some(rc => {
    try { return readFileSync(rc, 'utf-8').includes('# >>> unsnooze >>>'); }
    catch { return false; }
  });
}

function daemonRunning() {
  try {
    const pid = parseInt(readFileSync(RESUMER_LOCK, 'utf-8'), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- report ---------------------------------------------------------------------

/**
 * Run every check. Findings: { id, kind: 'legacy'|'health'|'info', title,
 * detail, fix? } — `fix` is a machine-actionable descriptor consumed by
 * applyFixes. healthy === no legacy and no health findings.
 */
export async function runDoctor({
  runner = defaultRunner,
  platform = process.platform,
  launchAgentsDir = defaultLaunchAgentsDir(platform),
  csgStateDir = join(homedir(), '.claude-session-guard'),
  csgBinPath = defaultCsgPackagePath({ runner }),
  mux = getMultiplexer(),
  hookInstalled = defaultHookInstalled,
  wrappersInstalled = defaultWrappersInstalled,
} = {}) {
  const findings = [];

  const procs = findCsgProcesses({ runner });
  if (procs.length) {
    findings.push({
      id: 'csg-processes', kind: 'legacy',
      title: `${procs.length} old csg process(es) still running`,
      detail: procs.map(p => `  pid ${p.pid}: ${p.command}`).join('\n'),
      fix: { action: 'kill-processes', pids: procs.map(p => p.pid) },
    });
  }

  const units = findCsgAutostarts({ dir: launchAgentsDir });
  if (units.length) {
    findings.push({
      id: 'csg-autostart', kind: 'legacy',
      title: 'old csg daemon autostart unit(s) present',
      detail: units.map(u => `  ${u}`).join('\n'),
      fix: { action: 'remove-units', units, platform },
    });
  }

  if (existsSync(csgStateDir)) {
    findings.push({
      id: 'csg-state-dir', kind: 'legacy',
      title: `old csg state dir at ${csgStateDir}`,
      detail: '  contains the pre-rename ledger/logs; superseded by ~/.unsnooze',
      fix: { action: 'archive-dir', dir: csgStateDir },
    });
  }

  if (csgBinPath) {
    findings.push({
      id: 'csg-package', kind: 'legacy',
      title: `old claude-session-guard package still installed (${csgBinPath})`,
      detail: '  run: npm rm -g claude-session-guard',
      // npm owns the package (it may even be an npm-link to a dev repo) —
      // doctor only ever hints, never runs npm.
    });
  }

  if (!hookInstalled()) {
    findings.push({
      id: 'hook-missing', kind: 'health',
      title: 'Claude StopFailure hook is not installed',
      detail: '  run: unsnooze install --yes',
    });
  }
  if (!wrappersInstalled()) {
    findings.push({
      id: 'wrappers-missing', kind: 'health',
      title: 'shell wrappers are not installed',
      detail: '  run: unsnooze install --yes  (then: exec $SHELL)',
    });
  }
  let muxOk = false;
  try { muxOk = !!mux.available(); } catch { muxOk = false; }
  if (!muxOk) {
    findings.push({
      id: 'mux-missing', kind: 'health',
      title: `${mux.name || 'tmux'} is not installed — limit-watch and revival are off`,
      detail: `  install ${mux.name || 'tmux'} to enable auto-resume`,
    });
  }

  findings.push({
    id: 'daemon', kind: 'info',
    title: daemonRunning() ? 'resumer/daemon: running' : 'resumer/daemon: not running (starts on the next limit stop)',
    detail: '',
  });

  const healthy = findings.every(f => f.kind === 'info');
  return { findings, healthy };
}

// --- fixes ------------------------------------------------------------------------

function defaultKill(pid) {
  try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
}

/** Apply the machine-actionable fixes from a runDoctor report. */
export async function applyFixes(report, {
  kill = defaultKill,
  runner = defaultRunner,
  now = Date.now(),
} = {}) {
  const actions = [];
  for (const finding of report.findings) {
    const fix = finding.fix;
    if (!fix) continue;
    if (fix.action === 'kill-processes') {
      for (const pid of fix.pids) {
        kill(pid);
        actions.push({ action: 'killed', pid });
        log(`doctor: SIGTERM csg process ${pid}`);
      }
    } else if (fix.action === 'remove-units') {
      for (const unit of fix.units) {
        if (fix.platform === 'darwin') runner('launchctl', ['unload', unit]);
        else runner('systemctl', ['--user', 'disable', '--now', unit]);
        try { unlinkSync(unit); } catch { /* already gone */ }
        actions.push({ action: 'removed-unit', unit });
        log(`doctor: removed csg autostart ${unit}`);
      }
    } else if (fix.action === 'archive-dir') {
      let target = `${fix.dir}.bak`;
      if (existsSync(target)) target = `${fix.dir}.bak.${now}`;
      try {
        renameSync(fix.dir, target);
        actions.push({ action: 'archived', from: fix.dir, to: target });
        log(`doctor: archived ${fix.dir} → ${target}`);
      } catch (err) {
        actions.push({ action: 'error', detail: `archive ${fix.dir}: ${err.message}` });
      }
    }
  }
  return actions;
}

// --- CLI --------------------------------------------------------------------------

export async function cmdDoctor(rest = [], deps = {}) {
  const { print = console.log, ...checkDeps } = deps;
  const wantFix = rest.includes('--fix');
  const report = await runDoctor(checkDeps);

  const legacy = report.findings.filter(f => f.kind === 'legacy');
  const health = report.findings.filter(f => f.kind === 'health');
  const info = report.findings.filter(f => f.kind === 'info');

  if (shouldUseTui() && print === console.log) {
    print(formatDoctorTui(report, { color: true }));
    if (report.healthy) return 0;
  } else {
    if (legacy.length) {
      print('unsnooze doctor — leftovers from the old claude-session-guard (csg) install:');
      for (const f of legacy) {
        print(`  ✗ ${f.title}`);
        if (f.detail) print(f.detail);
      }
    }
    if (health.length) {
      print('unsnooze doctor — install health:');
      for (const f of health) {
        print(`  ✗ ${f.title}`);
        if (f.detail) print(f.detail);
      }
    }
    for (const f of info) print(`  · ${f.title}`);

    if (report.healthy) {
      print('unsnooze doctor: all clear — install is healthy.');
      return 0;
    }
  }

  if (wantFix) {
    const actions = await applyFixes(report, deps);
    for (const a of actions) {
      if (a.action === 'killed') print(`  ✓ stopped csg process ${a.pid}`);
      else if (a.action === 'removed-unit') print(`  ✓ removed ${a.unit}`);
      else if (a.action === 'archived') print(`  ✓ archived ${a.from} → ${a.to}`);
      else if (a.action === 'error') print(`  ! ${a.detail}`);
    }
    const pkg = legacy.find(f => f.id === 'csg-package');
    if (pkg) print('  → finish up manually: npm rm -g claude-session-guard');
    return 0;
  }

  print(legacy.length
    ? '\nRun `unsnooze doctor --fix` to stop csg processes, remove its autostart, and archive its state.'
    : '\nSee the hints above to finish the install.');
  return 1;
}
