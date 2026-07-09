// Install / uninstall: wires unsnooze into the shell and Claude Code, and migrates
// off claude-auto-retry.
//   - ~/.claude/settings.json: StopFailure hook → unsnooze _hook-stopfailure
//     (removes any claude-auto-retry hook entry; preserves everything else;
//     backs up first; atomic write)
//   - ~/.zshrc: fence-marked claude() wrapper block (removes the old
//     claude-auto-retry fenced block)
// --settings <path> / --zshrc <path> override targets (used by tests).

import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { CLAUDE_SETTINGS, STATE_DIR } from './config.js';
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

export function wrapperBlock() {
  return `${FENCE_OPEN}
# claude() wrapper: routes every interactive claude launch through
# unsnooze so limit stops are recorded and auto-resumed.
unalias claude 2>/dev/null || true
claude() {
  if [ "\${UNSNOOZE_ACTIVE}" = "1" ]; then
    command claude "$@"
    return $?
  fi
  node "${UNSNOOZE_BIN}" "$@"
}
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

export function installZshrcBlock(content) {
  let cleaned = content;
  let oldRemoved = false;
  for (const { open, close } of LEGACY_FENCES) {
    const r = stripFencedBlock(cleaned, open, close);
    cleaned = r.content;
    oldRemoved = oldRemoved || r.found;
  }
  ({ content: cleaned } = stripFencedBlock(cleaned, FENCE_OPEN, FENCE_CLOSE));
  const result = cleaned.replace(/\n+$/, '\n') + '\n' + wrapperBlock() + '\n';
  return { content: result, oldRemoved };
}

// --- commands ---

export function cmdInstall(rest) {
  const opts = parseArgs(rest);

  // 1. settings.json
  if (existsSync(opts.settings)) {
    copyFileSync(opts.settings, `${opts.settings}.unsnooze-bak`);
    const before = readFileSync(opts.settings, 'utf-8');
    const after = mergeHookIntoSettings(before);
    atomicWrite(opts.settings, after);
    console.log(`unsnooze: StopFailure hook installed in ${opts.settings} (backup: ${opts.settings}.unsnooze-bak)`);
  } else {
    atomicWrite(opts.settings, mergeHookIntoSettings('{}'));
    console.log(`unsnooze: created ${opts.settings} with StopFailure hook`);
  }

  // 2. zshrc
  const zshrcContent = existsSync(opts.zshrc) ? readFileSync(opts.zshrc, 'utf-8') : '';
  const hasOld = zshrcContent.includes(OLD_FENCE_OPEN) || zshrcContent.includes('CLAUDE_AUTO_RETRY_ACTIVE');
  if (hasOld && !opts.yes) {
    console.log('unsnooze: found the old claude-auto-retry wrapper in your zshrc.');
    console.log('unsnooze: re-run with --yes to replace it, or remove the fenced');
    console.log(`unsnooze: "${OLD_FENCE_OPEN}" block manually first.`);
    return 1;
  }
  copyFileSync(opts.zshrc, `${opts.zshrc}.unsnooze-bak`);
  const { content, oldRemoved } = installZshrcBlock(zshrcContent);
  atomicWrite(opts.zshrc, content);
  console.log(`unsnooze: claude() wrapper installed in ${opts.zshrc}${oldRemoved ? ' (legacy wrapper block removed)' : ''} (backup: ${opts.zshrc}.unsnooze-bak)`);

  console.log('\nunsnooze: done. Reload your shell:');
  console.log('  exec zsh');
  return 0;
}

export function cmdUninstall(rest) {
  const opts = parseArgs(rest);

  if (existsSync(opts.settings)) {
    const before = readFileSync(opts.settings, 'utf-8');
    atomicWrite(opts.settings, removeHookFromSettings(before));
    console.log(`unsnooze: StopFailure hook removed from ${opts.settings}`);
  }

  if (existsSync(opts.zshrc)) {
    const { content, found } = stripFencedBlock(readFileSync(opts.zshrc, 'utf-8'), FENCE_OPEN, FENCE_CLOSE);
    if (found) {
      atomicWrite(opts.zshrc, content);
      console.log(`unsnooze: claude() wrapper removed from ${opts.zshrc}`);
    }
  }

  if (opts.purge) {
    rmSync(STATE_DIR, { recursive: true, force: true });
    console.log(`unsnooze: state dir ${STATE_DIR} removed`);
  }
  return 0;
}
