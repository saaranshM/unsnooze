// xAI Grok Build adapter — EXPERIMENTAL.
//
// Grok Build is closed source and its usage-limit banner text has no public
// documentation, so limit detection uses generic patterns and leans on the
// 5-hour fallback when no reset time parses. What IS documented (docs.x.ai):
//   - hooks are Claude-Code-compatible JSON, events include StopFailure,
//     read from ~/.grok/hooks/*.json — so the hook channel works
//   - sessions live in ~/.grok/sessions/, resume via `grok --resume [<id>]`
//     or `grok -c` (most recent, keyed by cwd)
// Users can improve the patterns by sending real captures: `unsnooze report`.
//
// NOTE: the community superagent-ai/grok-cli also installs a `grok` binary and
// also uses ~/.grok — that one is API-key-only (no usage windows) and is NOT
// the target; isCommunityGrokCli() tells them apart for the setup wizard.

import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const GROK_DIR = () => process.env.UNSNOOZE_GROK_DIR || join(homedir(), '.grok');

const LIMIT_ANCHORS = [
  /usage (?:limit|quota)/i,
  /rate limit exceeded/i,
  /reached your .*(?:limit|quota)/i,
  /out of credits/i,
];

export const patterns = {
  limitPatterns: LIMIT_ANCHORS,
  // Anchors double as reset lines (single-line banners): unparseable reset
  // text falls back to the 5h default and self-corrects on verify.
  resetPatterns: [
    /try again/i,
    /resets?\s/i,
    ...LIMIT_ANCHORS,
  ],
  weeklyPatterns: [/week(?:ly)?\s+(?:limit|quota)/i],
  fiveHourPatterns: [],
  // The shortcuts bar is contextual; cancel/interject hints mean a turn is running.
  busyPatterns: [
    /cancel the running turn/i,
    /interject/i,
    /esc to interrupt/i,
  ],
  idleRegex: /[›❯>]/,
  overloadPatterns: [/API error/i, /5\d\d\b.*error/i],
  transientPatterns: [/API error/i],
};

export function isCommunityGrokCli({ grokDir = GROK_DIR() } = {}) {
  // Official Grok Build: ~/.grok/config.toml. Community grok-cli: user-settings.json.
  return existsSync(join(grokDir, 'user-settings.json')) && !existsSync(join(grokDir, 'config.toml'));
}

// Grok reads Claude-Code-format hook JSON from ~/.grok/hooks/*.json — install
// our StopFailure handler in a file we own outright (trivial uninstall, no
// merging with user config).
export function installGrokHooks({ grokDir = GROK_DIR(), unsnoozeBin } = {}) {
  const hooksDir = join(grokDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const bin = unsnoozeBin || process.argv[1] || 'unsnooze';
  const config = {
    hooks: {
      StopFailure: [{
        matcher: 'overloaded|server_error|rate_limit',
        hooks: [{ type: 'command', command: `node ${bin} _hook-stopfailure --agent grok`, timeout: 5 }],
      }],
    },
  };
  const file = join(hooksDir, 'unsnooze.json');
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return file;
}

export function uninstallGrokHooks({ grokDir = GROK_DIR() } = {}) {
  rmSync(join(grokDir, 'hooks', 'unsnooze.json'), { force: true });
}

export default {
  id: 'grok',
  name: 'Grok Build (xAI)',
  bin: process.env.UNSNOOZE_GROK_BIN || 'grok',
  experimental: true,
  patterns,
  menu: null,
  resumeArgs(sessionId) {
    return { args: sessionId ? ['--resume', sessionId] : ['-c'], messageViaPane: true };
  },
  // Session file format is undocumented; null keeps it conservative — the
  // reopen path then uses `grok -c`, which Grok itself scopes to the cwd.
  latestSessionId() {
    return null;
  },
  isForegroundCommand(cmd) {
    return cmd === 'grok' || cmd === 'node' || cmd === 'unsnooze';
  },
};
