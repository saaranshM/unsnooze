// Install / uninstall: wires csg into the shell and Claude Code, and migrates
// off claude-auto-retry.
//   - ~/.claude/settings.json: StopFailure hook → csg _hook-stopfailure
//     (removes any claude-auto-retry hook entry; preserves everything else;
//     backs up first; atomic write)
//   - ~/.zshrc: fence-marked claude() wrapper block (removes the old
//     claude-auto-retry fenced block)
// --settings <path> / --zshrc <path> override targets (used by tests).

import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { CLAUDE_SETTINGS, STATE_DIR } from './config.js';
import { CSG_BIN } from './spawn.js';

const FENCE_OPEN = '# >>> claude-session-guard >>>';
const FENCE_CLOSE = '# <<< claude-session-guard <<<';
const OLD_FENCE_OPEN = '# >>> claude-auto-retry >>>';
const OLD_FENCE_CLOSE = '# <<< claude-auto-retry <<<';

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
  return (entry.hooks || []).some(h => (h.command || '').includes('csg.js _hook-stopfailure'));
}
function isAutoRetry(entry) {
  return (entry.hooks || []).some(h => (h.command || '').includes('claude-auto-retry'));
}

export function mergeHookIntoSettings(settingsJson) {
  const settings = JSON.parse(settingsJson);
  settings.hooks = settings.hooks || {};
  const list = (settings.hooks.StopFailure || []).filter(e => !isAutoRetry(e) && !isOurs(e));
  list.push({
    matcher: 'overloaded|server_error|rate_limit',
    hooks: [{ type: 'command', command: `node ${CSG_BIN} _hook-stopfailure`, timeout: 5 }],
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
# claude-session-guard so limit stops are recorded and auto-resumed.
unalias claude 2>/dev/null || true
claude() {
  if [ "\${CSG_ACTIVE}" = "1" ]; then
    command claude "$@"
    return $?
  fi
  node "${CSG_BIN}" "$@"
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
  let { content: cleaned, found: oldRemoved } = stripFencedBlock(content, OLD_FENCE_OPEN, OLD_FENCE_CLOSE);
  ({ content: cleaned } = stripFencedBlock(cleaned, FENCE_OPEN, FENCE_CLOSE));
  const result = cleaned.replace(/\n+$/, '\n') + '\n' + wrapperBlock() + '\n';
  return { content: result, oldRemoved };
}

// --- commands ---

export function cmdInstall(rest) {
  const opts = parseArgs(rest);

  // 1. settings.json
  if (existsSync(opts.settings)) {
    copyFileSync(opts.settings, `${opts.settings}.csg-bak`);
    const before = readFileSync(opts.settings, 'utf-8');
    const after = mergeHookIntoSettings(before);
    atomicWrite(opts.settings, after);
    console.log(`csg: StopFailure hook installed in ${opts.settings} (backup: ${opts.settings}.csg-bak)`);
  } else {
    atomicWrite(opts.settings, mergeHookIntoSettings('{}'));
    console.log(`csg: created ${opts.settings} with StopFailure hook`);
  }

  // 2. zshrc
  const zshrcContent = existsSync(opts.zshrc) ? readFileSync(opts.zshrc, 'utf-8') : '';
  const hasOld = zshrcContent.includes(OLD_FENCE_OPEN) || zshrcContent.includes('CLAUDE_AUTO_RETRY_ACTIVE');
  if (hasOld && !opts.yes) {
    console.log('csg: found the old claude-auto-retry wrapper in your zshrc.');
    console.log('csg: re-run with --yes to replace it, or remove the fenced');
    console.log(`csg: "${OLD_FENCE_OPEN}" block manually first.`);
    return 1;
  }
  copyFileSync(opts.zshrc, `${opts.zshrc}.csg-bak`);
  const { content, oldRemoved } = installZshrcBlock(zshrcContent);
  atomicWrite(opts.zshrc, content);
  console.log(`csg: claude() wrapper installed in ${opts.zshrc}${oldRemoved ? ' (old claude-auto-retry block removed)' : ''} (backup: ${opts.zshrc}.csg-bak)`);

  console.log('\ncsg: done. Finish the migration with:');
  console.log('  npm uninstall -g claude-auto-retry');
  console.log('  exec zsh   # reload your shell');
  return 0;
}

export function cmdUninstall(rest) {
  const opts = parseArgs(rest);

  if (existsSync(opts.settings)) {
    const before = readFileSync(opts.settings, 'utf-8');
    atomicWrite(opts.settings, removeHookFromSettings(before));
    console.log(`csg: StopFailure hook removed from ${opts.settings}`);
  }

  if (existsSync(opts.zshrc)) {
    const { content, found } = stripFencedBlock(readFileSync(opts.zshrc, 'utf-8'), FENCE_OPEN, FENCE_CLOSE);
    if (found) {
      atomicWrite(opts.zshrc, content);
      console.log(`csg: claude() wrapper removed from ${opts.zshrc}`);
    }
  }

  if (opts.purge) {
    rmSync(STATE_DIR, { recursive: true, force: true });
    console.log(`csg: state dir ${STATE_DIR} removed`);
  }
  return 0;
}
