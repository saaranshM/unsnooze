// Claude Design support (issue #13).
//
// Claude Design has three surfaces: the canvas at claude.ai/design, the Claude
// Desktop sidebar, and — the one that matters here — an official MCP server
// that Claude Code drives from the terminal:
//
//   claude mcp add --scope user --transport http claude-design \
//     https://api.anthropic.com/v1/design/mcp
//   /design-login
//
// unsnooze deliberately supports only that third surface. The canvas is a web
// app, and Anthropic's Consumer ToS bars accessing Claude "through automated or
// non-human means, whether through a bot, script, or otherwise" — driving it
// with a headless browser risks the user's account, and Claude Code is the
// documented exemption. There is no version of this file that opens a browser.
//
// Design draws from the same 5-hour and weekly pool as chat, Cowork and Claude
// Code (it had its own weekly allowance once; it does not now), so a design
// session that stops is an ordinary limit stop and the existing machinery
// already handles it. What was missing was setup and visibility, which is all
// this module adds.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DESIGN_MCP_NAME = 'claude-design';
export const DESIGN_MCP_URL = 'https://api.anthropic.com/v1/design/mcp';

export function designMcpAddArgs() {
  return ['mcp', 'add', '--scope', 'user', '--transport', 'http',
    DESIGN_MCP_NAME, DESIGN_MCP_URL];
}

function defaultRunner(args) {
  const bin = process.env.UNSNOOZE_CLAUDE_BIN || 'claude';
  const r = spawnSync(bin, args, { encoding: 'utf-8' });
  if (r.error) throw r.error;
  return `${r.stdout || ''}${r.stderr || ''}`;
}

// One row per configured MCP server, from `claude mcp list`. Real output:
//
//   Checking MCP server health…
//   [mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp (…)
//   claude.ai Notion: https://mcp.notion.com/mcp - ! Needs authentication
//   plugin:context7:context7: https://mcp.context7.com/mcp (HTTP) - ✔ Connected
//
// Two shapes make this fussier than a split(': '): names carry both colons
// (plugin:context7:context7) and spaces (claude.ai Notion), and the SDK prints
// unrelated diagnostics that look like rows. So the row separator is the LAST
// ' - ' on the line, and the name is everything before the first COLON-SPACE —
// which no name contains, because a bare colon inside a name is never followed
// by a space.
export function parseMcpList(stdout) {
  if (typeof stdout !== 'string' || stdout === '') return [];
  const rows = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('[')) continue;   // sdk diagnostics
    const sep = line.lastIndexOf(' - ');
    if (sep === -1) continue;
    const head = line.slice(0, sep);
    const status = line.slice(sep + 3).trim();
    const colon = head.indexOf(': ');
    if (colon === -1) continue;
    const name = head.slice(0, colon).trim();
    if (!name) continue;
    const target = head.slice(colon + 2).trim();
    const needsAuth = /needs? authentication/i.test(status);
    rows.push({
      name,
      target,
      status,
      connected: /connected/i.test(status) && !needsAuth,
      needsAuth,
    });
  }
  return rows;
}

// Registration, answered from disk instead of over the wire.
//
// `claude mcp list` health-checks every configured server, which takes seconds
// — fine for an explicit `unsnooze design`, far too slow for `unsnooze doctor`,
// which people run casually. `--scope user` writes the TOP-LEVEL mcpServers map
// in ~/.claude.json; the per-project maps under .projects are a different scope
// and must not be mistaken for it.
export function designRegisteredOffline({
  readConfig = () => readFileSync(join(homedir(), '.claude.json'), 'utf-8'),
} = {}) {
  try {
    const parsed = JSON.parse(readConfig());
    return Boolean(parsed?.mcpServers?.[DESIGN_MCP_NAME]);
  } catch {
    return false;   // missing, unreadable or corrupt — treat as not set up
  }
}

// Is this machine ready to run Claude Design work from the terminal?
//
// Three distinguishable states, because the remedies differ completely:
//   - claude missing/broken  -> nothing to do with Design at all
//   - not registered         -> `unsnooze design setup`
//   - registered, logged out -> `/design-login`, and note that this one is
//     NOT a usage limit: no amount of waiting clears it.
export function designStatus({ runner = defaultRunner } = {}) {
  let out;
  try {
    out = runner(['mcp', 'list']);
  } catch (err) {
    return {
      available: false, registered: false, connected: false, needsAuth: false,
      hint: `could not run \`claude mcp list\` (${err.message}) — is the claude CLI installed?`,
    };
  }
  const row = parseMcpList(out).find(r => r.name === DESIGN_MCP_NAME);
  if (!row) {
    return {
      available: true, registered: false, connected: false, needsAuth: false,
      hint: 'Claude Design is not wired into Claude Code — run `unsnooze design setup`',
    };
  }
  if (row.needsAuth || !row.connected) {
    return {
      available: true, registered: true, connected: false, needsAuth: true,
      hint: 'Claude Design is registered but signed out — run `/design-login` inside Claude Code. '
        + 'This is not a usage limit; waiting will not clear it.',
    };
  }
  return {
    available: true, registered: true, connected: true, needsAuth: false,
    hint: 'Claude Design is connected — design sessions are watched like any other Claude Code session',
  };
}

// Register the MCP server. Editing the user's Claude config is not something to
// do quietly, so this is only ever reached from an explicit `unsnooze design
// setup`, and it prints exactly what it ran.
export function installDesignMcp({ runner = defaultRunner } = {}) {
  const args = designMcpAddArgs();
  try {
    return { ok: true, output: runner(args), args };
  } catch (err) {
    return { ok: false, output: err.message, args };
  }
}

// --- command ---------------------------------------------------------------

const USAGE = `unsnooze design — Claude Design from the terminal

  unsnooze design            show whether Claude Design is wired up
  unsnooze design setup      register the claude-design MCP server with Claude Code

Claude Design's canvas (claude.ai/design, Claude Desktop) is a web surface and
unsnooze does not automate it: Anthropic's Consumer Terms bar automated access
to claude.ai, and doing it anyway risks your account. The supported route is the
claude-design MCP server inside Claude Code, which unsnooze watches like any
other Claude Code session.
`;

export function cmdDesign(rest = [], { runner = defaultRunner, log = console.log } = {}) {
  const sub = rest[0];

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    log(USAGE);
    return 0;
  }

  if (sub === 'setup') {
    const before = designStatus({ runner });
    if (!before.available) {
      log(`unsnooze: ${before.hint}`);
      return 1;
    }
    if (before.registered) {
      log(`unsnooze: ${DESIGN_MCP_NAME} is already registered.`);
      log(`unsnooze: ${before.hint}`);
      return 0;
    }
    log(`unsnooze: running \`claude ${designMcpAddArgs().join(' ')}\``);
    const result = installDesignMcp({ runner });
    if (!result.ok) {
      log(`unsnooze: registration failed — ${result.output}`);
      return 1;
    }
    log('unsnooze: registered. Now run `/design-login` inside Claude Code to sign in.');
    log('unsnooze: design work shares your usual 5-hour and weekly limits, so a');
    log('unsnooze: design session that stops is resumed like any other.');
    return 0;
  }

  if (sub && sub !== 'status') {
    log(`unsnooze: unknown design subcommand "${sub}"`);
    log(USAGE);
    return 1;
  }

  const status = designStatus({ runner });
  log(`unsnooze: ${status.hint}`);
  if (status.connected) {
    log('unsnooze: tip — long design runs burn context fast; set');
    log('unsnooze:   unsnooze config set launchExtraArgs.claude "--autocompact 400000"');
    log('unsnooze: so a context-heavy session compacts instead of stalling.');
  }
  return status.connected ? 0 : 1;
}
