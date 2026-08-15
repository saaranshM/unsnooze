// Claude Design support.
//
// Claude Design's canvas is web/desktop only, and Anthropic's Consumer ToS
// bars automated access to claude.ai — so unsnooze does not and will not drive
// it. What it can do is the officially supported terminal route: the
// claude-design MCP server inside Claude Code, which shares the same 5-hour and
// weekly pool as everything else and therefore stops in exactly the way
// unsnooze already handles.
//
// The fixtures below are real `claude mcp list` output, captured 2026-08-16.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMcpList, designStatus, designMcpAddArgs, DESIGN_MCP_NAME, DESIGN_MCP_URL,
  cmdDesign, designRegisteredOffline,
} from '../src/design.js';

const REAL_LIST = `Checking MCP server health…

[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp (pre-upgrade storage or provider not round-tripping the value). SEP-2352 isolation is inactive for this read; ensure your provider round-trips the issuer field.
claude.ai Notion: https://mcp.notion.com/mcp - ! Needs authentication
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
plugin:playwright:playwright: npx @playwright/mcp@latest - ✔ Connected
plugin:context7:context7: https://mcp.context7.com/mcp (HTTP) - ✔ Connected
gemini: npx @houtini/gemini-mcp - ✔ Connected
`;

const WITH_DESIGN = REAL_LIST
  + `claude-design: https://api.anthropic.com/v1/design/mcp (HTTP) - ✔ Connected\n`;

const DESIGN_LOGGED_OUT = REAL_LIST
  + `claude-design: https://api.anthropic.com/v1/design/mcp (HTTP) - ! Needs authentication\n`;

test('the mcp list parser survives the health header and sdk warnings', () => {
  const rows = parseMcpList(REAL_LIST);
  assert.ok(rows.length >= 5, `expected real rows, got ${rows.length}`);
  assert.ok(!rows.some(r => /Checking MCP server health/.test(r.name)));
  assert.ok(!rows.some(r => /SEP-2352/.test(r.name)));
});

test('server names containing colons are not split apart', () => {
  const rows = parseMcpList(REAL_LIST);
  const names = rows.map(r => r.name);
  assert.ok(names.includes('plugin:context7:context7'),
    `plugin names carry colons; got ${JSON.stringify(names)}`);
  assert.ok(names.includes('claude.ai Notion'), 'names can carry spaces too');
});

test('connection status is read per server', () => {
  const rows = parseMcpList(REAL_LIST);
  const byName = Object.fromEntries(rows.map(r => [r.name, r]));
  assert.equal(byName['claude.ai Gmail'].connected, true);
  assert.equal(byName['claude.ai Notion'].connected, false);
  assert.equal(byName['claude.ai Notion'].needsAuth, true);
});

test('an empty or unparseable listing yields no rows rather than throwing', () => {
  assert.deepEqual(parseMcpList(''), []);
  assert.deepEqual(parseMcpList(null), []);
  assert.deepEqual(parseMcpList('total nonsense with no separator'), []);
});

// --- design status ---------------------------------------------------------

test('design reports unregistered when the server is absent', () => {
  const s = designStatus({ runner: () => REAL_LIST });
  assert.equal(s.registered, false);
  assert.equal(s.connected, false);
  assert.match(s.hint, /unsnooze design setup/,
    'an unregistered server must say how to register it');
});

test('design reports ready when the server is registered and connected', () => {
  const s = designStatus({ runner: () => WITH_DESIGN });
  assert.equal(s.registered, true);
  assert.equal(s.connected, true);
});

test('a registered-but-logged-out server is called out as needing /design-login', () => {
  // This is the failure that waiting cannot fix: unlike a usage limit, an
  // expired design login never clears on its own.
  const s = designStatus({ runner: () => DESIGN_LOGGED_OUT });
  assert.equal(s.registered, true);
  assert.equal(s.connected, false);
  assert.equal(s.needsAuth, true);
  assert.match(s.hint, /\/design-login/);
});

test('a missing or broken claude CLI is reported, not crashed on', () => {
  const s = designStatus({ runner: () => { throw new Error('ENOENT'); } });
  assert.equal(s.registered, false);
  assert.equal(s.available, false);
  assert.match(s.hint, /claude/i);
});

// --- registration ----------------------------------------------------------

test('the add command matches Anthropic documented invocation', () => {
  const args = designMcpAddArgs();
  assert.deepEqual(args, [
    'mcp', 'add', '--scope', 'user', '--transport', 'http',
    DESIGN_MCP_NAME, DESIGN_MCP_URL,
  ]);
  assert.equal(DESIGN_MCP_URL, 'https://api.anthropic.com/v1/design/mcp');
});

// --- the command -----------------------------------------------------------

function capture(rest, runner) {
  const lines = [];
  const code = cmdDesign(rest, { runner, log: (...a) => lines.push(a.join(' ')) });
  return { code, out: lines.join('\n') };
}

test('status exits non-zero until design is actually usable', () => {
  assert.equal(capture([], () => REAL_LIST).code, 1, 'unregistered is not ready');
  assert.equal(capture([], () => DESIGN_LOGGED_OUT).code, 1, 'signed out is not ready');
  assert.equal(capture([], () => WITH_DESIGN).code, 0, 'connected is ready');
});

test('setup runs the documented mcp add and then points at /design-login', () => {
  const ran = [];
  const runner = args => {
    ran.push(args.join(' '));
    return args[1] === 'list' ? REAL_LIST : 'Added stdio MCP server claude-design';
  };
  const { code, out } = capture(['setup'], runner);
  assert.equal(code, 0);
  assert.ok(ran.some(a => a.startsWith('mcp add --scope user --transport http claude-design')));
  assert.match(out, /\/design-login/, 'registration alone does not sign you in');
});

test('setup is idempotent — an existing registration is left alone', () => {
  const ran = [];
  const runner = args => { ran.push(args[1]); return WITH_DESIGN; };
  const { code } = capture(['setup'], runner);
  assert.equal(code, 0);
  assert.ok(!ran.includes('add'), 'must not re-register an existing server');
});

test('a connected setup surfaces the context lever the reporter needed', () => {
  const { out } = capture([], () => WITH_DESIGN);
  assert.match(out, /launchExtraArgs\.claude/);
  assert.match(out, /--autocompact/);
});

test('the help text states plainly that the web canvas is not automated', () => {
  // This is a permanent scope decision, not a TODO: automating claude.ai
  // violates Anthropic's Consumer Terms and risks the user's account. If this
  // assertion ever needs deleting, something has gone badly wrong.
  const { out } = capture(['--help'], () => REAL_LIST);
  assert.match(out, /does not automate it/i);
  assert.match(out, /Consumer Terms/i);
});

test('an unknown subcommand fails loudly instead of silently doing nothing', () => {
  const { code, out } = capture(['frobnicate'], () => REAL_LIST);
  assert.equal(code, 1);
  assert.match(out, /unknown design subcommand/);
});

// --- offline registration check --------------------------------------------

test('registration can be read from config without probing the network', () => {
  // `claude mcp list` health-checks every configured server, which takes
  // seconds. doctor runs often and must stay cheap, so the registration
  // question is answered from ~/.claude.json instead.
  const cfg = JSON.stringify({ mcpServers: { 'claude-design': { type: 'http', url: DESIGN_MCP_URL } } });
  assert.equal(designRegisteredOffline({ readConfig: () => cfg }), true);
});

test('project-scoped servers do not count as a user-scope registration', () => {
  // `--scope user` writes the top-level mcpServers map; the per-project maps
  // under .projects are a different thing entirely.
  const cfg = JSON.stringify({
    mcpServers: {},
    projects: { '/some/repo': { mcpServers: { 'claude-design': {} } } },
  });
  assert.equal(designRegisteredOffline({ readConfig: () => cfg }), false);
});

test('a missing or corrupt config reads as not registered, never throws', () => {
  assert.equal(designRegisteredOffline({ readConfig: () => { throw new Error('ENOENT'); } }), false);
  assert.equal(designRegisteredOffline({ readConfig: () => 'not json{' }), false);
  assert.equal(designRegisteredOffline({ readConfig: () => '{}' }), false);
});
