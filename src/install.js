// Install / uninstall: wires unsnooze into the shell and the agent CLIs, and
// migrates off claude-auto-retry / the pre-release csg.
//   - ~/.claude/settings.json: StopFailure hook → unsnooze _hook-stopfailure
//     (removes legacy hook entries; preserves everything else; backs up first;
//     atomic write)
//   - ~/.zshrc + ~/.bashrc: one fence-marked block with a wrapper function per
//     enabled agent (claude/codex/grok), routed through `unsnooze _run`
//   - ~/.grok/hooks/unsnooze.json when the grok agent is enabled
// --settings <path> / --zshrc <path> override targets (used by tests).

import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { CLAUDE_SETTINGS, STATE_DIR } from './config.js';
import { getConfig, configFileExists } from './settings.js';
import { installGrokHooks, uninstallGrokHooks } from './agents/grok.js';
import { UNSNOOZE_BIN } from './spawn.js';

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
  const opts = { yes: false, settings: CLAUDE_SETTINGS, zshrc: join(homedir(), '.zshrc'), purge: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--yes' || rest[i] === '-y') opts.yes = true;
    else if (rest[i] === '--purge') opts.purge = true;
    else if (rest[i] === '--settings') opts.settings = rest[++i];
    else if (rest[i] === '--zshrc') opts.zshrc = rest[++i];
  }
  return opts;
}

function atomicWrite(path, content) {
  const tmp = join(dirname(path), `.${Date.now()}.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// --- settings.json hook management ---

function isOurs(entry) {
  return (entry.hooks || []).some(h => (h.command || '').includes('unsnooze.js _hook-stopfailure'));
}
function isLegacy(entry) {
  return (entry.hooks || []).some(h => /claude-auto-retry|csg\.js _hook-stopfailure/.test(h.command || ''));
}

export function mergeHookIntoSettings(settingsJson) {
  const settings = JSON.parse(settingsJson);
  settings.hooks = settings.hooks || {};
  const list = (settings.hooks.StopFailure || []).filter(e => !isLegacy(e) && !isOurs(e));
  list.push({
    matcher: 'overloaded|server_error|rate_limit',
    hooks: [{ type: 'command', command: `node ${UNSNOOZE_BIN} _hook-stopfailure`, timeout: 5 }],
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
  const fns = agents.map(id => `unalias ${id} 2>/dev/null || true
${id}() {
  if [ "\${UNSNOOZE_ACTIVE}" = "1" ]; then
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

// --- commands ---

export function enabledAgents() {
  return ['claude', 'codex', 'grok'].filter(id => getConfig(`agents.${id}`));
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

  console.log('\nunsnooze: done. Reload your shell:');
  console.log('  exec $SHELL');
  return 0;
}

export function cmdUninstall(rest) {
  const opts = parseArgs(rest);
  const explicitRc = rest.includes('--zshrc');

  if (existsSync(opts.settings)) {
    const before = readFileSync(opts.settings, 'utf-8');
    atomicWrite(opts.settings, removeHookFromSettings(before));
    console.log(`unsnooze: StopFailure hook removed from ${opts.settings}`);
  }

  uninstallGrokHooks();

  for (const rc of rcTargets(opts, explicitRc)) {
    if (!existsSync(rc)) continue;
    const { content, found } = stripFencedBlock(readFileSync(rc, 'utf-8'), FENCE_OPEN, FENCE_CLOSE);
    if (found) {
      atomicWrite(rc, content);
      console.log(`unsnooze: wrappers removed from ${rc}`);
    }
  }

  if (opts.purge) {
    rmSync(STATE_DIR, { recursive: true, force: true });
    console.log(`unsnooze: state dir ${STATE_DIR} removed`);
  }
  return 0;
}
