// `unsnooze prompt` — local prompt-queue CLI: queue a one-shot prompt that
// spawns a NEW agent session in a project cwd once a usage limit clears.
// `--host <name>` fans the same subcommands out over the fleet transport
// (src/fleet.js's remoteQueue* functions -> src/remote.js's queue-* verbs on
// the target host) instead of touching local state.

import { existsSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import * as p from '@clack/prompts';
import {
  queueAdd, queueList, queueRemove, queueClear, resolveAgentResetAnchor,
} from './prompt-queue.js';
import { listAgents } from './agents/index.js';
import { getConfig } from './settings.js';
import { parseGoDuration } from './time-parser.js';
import { shortenHome } from './cli.js';
import {
  readHosts, remoteQueueAdd, remoteQueueList, remoteQueueRemove, remoteQueueClear,
} from './fleet.js';

function enabledAgentIds() {
  return listAgents().map(a => a.id).filter(id => getConfig(`agents.${id}`));
}

// Interactive default: @clack/prompts select, mirroring wizard.js's usage
// (p.select + p.isCancel). Injectable via cmdPrompt(rest, { prompter }) so
// tests can simulate a pick or a cancel without a real TTY.
async function defaultPrompter(ids) {
  const picked = await p.select({
    message: 'Which agent should run this prompt?',
    options: ids.map(id => ({ value: id, label: id })),
    initialValue: ids.includes('claude') ? 'claude' : ids[0],
  });
  return p.isCancel(picked) ? null : picked;
}

// --- --at parsing ----------------------------------------------------------

const INTEGER_RE = /^\d+$/;
const AMPM_CLOCK_RE = /^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)$/i;
const CLOCK_24H_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function to24h(hour, ampm) {
  if (ampm === 'pm' && hour !== 12) return hour + 12;
  if (ampm === 'am' && hour === 12) return 0;
  return hour;
}

// Next occurrence of hour:minute in LOCAL time — today if still ahead of
// `now`, else tomorrow. Never returns a time <= now.
function nextOccurrence(hour, minute, now) {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function parseClockTime(text, now) {
  const ampm = text.match(AMPM_CLOCK_RE);
  if (ampm) {
    const hour = parseInt(ampm[1], 10);
    if (hour < 1 || hour > 12) return null;
    const minute = ampm[2] ? parseInt(ampm[2], 10) : 0;
    return nextOccurrence(to24h(hour, ampm[3].toLowerCase()), minute, now);
  }
  const h24 = text.match(CLOCK_24H_RE);
  if (h24) return nextOccurrence(parseInt(h24[1], 10), parseInt(h24[2], 10), now);
  return null;
}

// Accepts, in order of attempt: epoch ms/seconds, ISO-8601, "+2h30m"/"+45m"
// Go-style durations, or a bare clock time ("14:30" / "2:05pm" / "7pm")
// rolled forward to its next local occurrence. Returns epoch ms, or null if
// nothing matched — the caller is responsible for erroring on null.
export function parseAtTime(text, now = Date.now()) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;

  if (INTEGER_RE.test(t)) {
    const n = Number(t);
    if (n > 1e12) return n;
    if (n >= 1e9) return n * 1000;
    return null;
  }

  if (t.includes('-') && t.includes(':')) {
    const parsed = Date.parse(t);
    if (!Number.isNaN(parsed)) return parsed;
  }

  if (t.startsWith('+')) {
    const waitMs = parseGoDuration(t.slice(1));
    if (waitMs > 0) return now + waitMs;
  }

  return parseClockTime(t, now);
}

// --- add ---------------------------------------------------------------

function parseAddArgs(args) {
  const flags = { agent: undefined, project: undefined, at: undefined, now: false };
  const textParts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--agent') { flags.agent = args[++i]; continue; }
    if (a === '--project') { flags.project = args[++i]; continue; }
    if (a === '--at') { flags.at = args[++i]; continue; }
    if (a === '--now') { flags.now = true; continue; }
    textParts.push(a);
  }
  return { flags, text: textParts.join(' ').trim() };
}

async function cmdPromptAdd(args, { prompter, spawn = true, spawnFn } = {}) {
  const { flags, text } = parseAddArgs(args);

  if (flags.at !== undefined && flags.now) {
    console.error('unsnooze prompt add: --at and --now cannot both be given');
    return 1;
  }

  const projectPath = resolve(flags.project || process.cwd());
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    console.error(`unsnooze prompt add: --project "${projectPath}" does not exist or is not a directory`);
    return 1;
  }

  const enabled = enabledAgentIds();
  let agentId = flags.agent;
  if (agentId !== undefined) {
    if (!enabled.includes(agentId)) {
      console.error(`unsnooze prompt add: unknown or disabled agent "${agentId}" (valid: ${enabled.join(', ')})`);
      return 1;
    }
  } else if (prompter) {
    // Explicit prompter always wins over the TTY gate — this is the test
    // seam (real picker or a scripted cancel), independent of stdin/stdout.
    const chosen = await prompter(enabled);
    if (chosen == null) {
      console.error('unsnooze prompt add: cancelled');
      return 1;
    }
    agentId = chosen;
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    const chosen = await defaultPrompter(enabled);
    if (chosen == null) {
      console.error('unsnooze prompt add: cancelled');
      return 1;
    }
    agentId = chosen;
  } else {
    agentId = 'claude';
  }

  let mode = 'next-reset';
  let atMs = null;
  if (flags.at !== undefined) {
    atMs = parseAtTime(flags.at);
    if (atMs == null) {
      console.error(`unsnooze prompt add: could not parse --at "${flags.at}"`);
      return 1;
    }
    mode = 'at';
  } else if (flags.now) {
    mode = 'now';
  }

  const result = queueAdd({
    cwd: projectPath, agent: agentId, prompt: text, mode, atMs,
    spawn, ...(spawnFn ? { spawnFn } : {}),
  });
  if (!result.ok) {
    console.error(result.error === 'duplicate'
      ? `unsnooze prompt add: duplicate — matches existing queued prompt ${result.existing.id}`
      : `unsnooze prompt add: ${result.error}`);
    return 1;
  }

  console.log(`unsnooze: queued prompt ${result.entry.id} for ${agentId} in ${shortenHome(projectPath)}`);
  if (mode === 'next-reset') {
    const { resetAtMs: at } = resolveAgentResetAnchor(agentId);
    console.log(at == null || at <= Date.now()
      ? `unsnooze: no active limit detected for ${agentId} — the prompt will be delivered on the next daemon tick; use --at to schedule a specific time.`
      : `unsnooze: delivery ETA ~ ${new Date(at).toLocaleString()}`);
  }
  return 0;
}

// --- list / remove / clear ----------------------------------------------

function fmtDue(e, now) {
  if (Number.isFinite(e.notBefore) && e.notBefore > now) {
    return `backoff until ${new Date(e.notBefore).toLocaleString()}`;
  }
  if (e.mode === 'now') return 'now';
  if (e.mode === 'at') return new Date(e.atMs).toLocaleString();
  return 'next reset';
}

// Shared by the local and --host list paths — an entry has either a full
// `prompt` (local, from queueList()) or a pre-truncated `promptPreview`
// (remote, sanitized on ingest by remoteQueueList); either shape renders the
// same table.
function printQueueEntries(entries, { host } = {}) {
  if (entries.length === 0) {
    console.log('no queued prompts');
    return;
  }
  const now = Date.now();
  const header = host ? `unsnooze: ${entries.length} queued prompt(s) on ${host}\n` : `unsnooze: ${entries.length} queued prompt(s)\n`;
  console.log(header);
  for (const e of entries) {
    const preview = typeof e.prompt === 'string'
      ? (e.prompt.length > 60 ? `${e.prompt.slice(0, 60)}…` : e.prompt)
      : (e.promptPreview ?? '');
    console.log(`  ${e.id}  ${(e.agent || 'claude').padEnd(8)} ${fmtDue(e, now).padEnd(28)} ${e.status.padEnd(9)} ${shortenHome(e.cwd)}`);
    console.log(`              "${preview}"`);
  }
}

function cmdPromptList(args) {
  const entries = queueList();
  if (args.includes('--json')) {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }
  printQueueEntries(entries);
  return 0;
}

function cmdPromptRemove(args) {
  const [id] = args;
  if (!id) { console.error('unsnooze prompt remove <id>'); return 1; }
  if (!queueRemove(id)) {
    console.error(`unsnooze prompt remove: no pending/launching prompt with id "${id}"`);
    return 1;
  }
  console.log(`unsnooze: removed prompt ${id}`);
  return 0;
}

function cmdPromptClear() {
  const count = queueClear();
  console.log(`unsnooze: cleared ${count} queued prompt(s)`);
  return 0;
}

// --- --host fan-out ---------------------------------------------------------
// Same four subcommands, routed to a remote host over the fleet transport
// instead of local state. Every remote failure funnels through one of two
// printers: needs-auth (a resolvable-credential problem — same "needs-setup"
// vocabulary `unsnooze hosts test` uses) or a flat error (bad-request,
// disabled, too-old-remote, ssh failure, ...).

function printHostNeedsAuth(hostName, result) {
  console.error(`unsnooze: ${hostName} needs-setup: ${result.error} (see \`unsnooze hosts test ${hostName}\`)`);
  return 1;
}

function extractHostFlag(args) {
  const idx = args.indexOf('--host');
  if (idx === -1) return { host: undefined, rest: args };
  const host = args[idx + 1];
  // A bare trailing --host (no value follows) must never silently fall
  // through to local routing — that would make e.g. `prompt clear --host`
  // clear the LOCAL queue instead of erroring, a destructive misdirection.
  if (host === undefined) return { host: undefined, rest: args, error: true };
  return { host, rest: [...args.slice(0, idx), ...args.slice(idx + 2)] };
}

// --project is required (there is no local cwd to default to on a remote
// filesystem) and --agent is required (remote enablement is unknown ahead of
// the round trip, so there is no interactive picker over ssh — see the
// module header). The cwd is passed through as-is: it names a path on the
// REMOTE host, so no local resolve()/existsSync() applies to it — the remote
// queue-add handler is the one that stats it (see src/remote.js).
async function cmdPromptHostAdd(hostName, args, remoteOpts) {
  const { flags, text } = parseAddArgs(args);

  if (flags.at !== undefined && flags.now) {
    console.error('unsnooze prompt add: --at and --now cannot both be given');
    return 1;
  }
  if (!flags.project) {
    console.error('unsnooze prompt add --host: --project is required (no local cwd to default to on a remote host)');
    return 1;
  }
  if (!isAbsolute(flags.project)) {
    console.error(`unsnooze prompt add --host: --project "${flags.project}" must be an absolute remote path`);
    return 1;
  }
  if (!flags.agent) {
    console.error('unsnooze prompt add --host: --agent is required (remote agent availability is unknown — no interactive picker over ssh)');
    return 1;
  }

  let mode = 'next-reset';
  let atMs = null;
  if (flags.at !== undefined) {
    atMs = parseAtTime(flags.at);
    if (atMs == null) {
      console.error(`unsnooze prompt add: could not parse --at "${flags.at}"`);
      return 1;
    }
    mode = 'at';
  } else if (flags.now) {
    mode = 'now';
  }

  const result = await remoteQueueAdd(hostName, { cwd: flags.project, agent: flags.agent, prompt: text, mode, atMs }, remoteOpts);
  if (result.needsAuth) return printHostNeedsAuth(hostName, result);
  if (!result.ok) {
    console.error(`unsnooze prompt add --host ${hostName}: ${result.error}`);
    return 1;
  }
  console.log(`unsnooze: queued prompt ${result.id} for ${flags.agent} on ${hostName}:${flags.project}`);
  return 0;
}

async function cmdPromptHostList(hostName, args, remoteOpts) {
  const result = await remoteQueueList(hostName, remoteOpts);
  if (result.needsAuth) return printHostNeedsAuth(hostName, result);
  if (!result.ok) {
    console.error(`unsnooze prompt list --host ${hostName}: ${result.error}`);
    return 1;
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(result.queue, null, 2));
    return 0;
  }
  printQueueEntries(result.queue, { host: hostName });
  return 0;
}

async function cmdPromptHostRemove(hostName, args, remoteOpts) {
  const [id] = args;
  if (!id) { console.error('unsnooze prompt remove <id> --host <name>'); return 1; }
  const result = await remoteQueueRemove(hostName, id, remoteOpts);
  if (result.needsAuth) return printHostNeedsAuth(hostName, result);
  if (!result.ok) {
    console.error(result.notFound
      ? `unsnooze prompt remove --host ${hostName}: no pending/launching prompt with id "${id}"`
      : `unsnooze prompt remove --host ${hostName}: ${result.error}`);
    return 1;
  }
  console.log(`unsnooze: removed prompt ${id} on ${hostName}`);
  return 0;
}

async function cmdPromptHostClear(hostName, remoteOpts) {
  const result = await remoteQueueClear(hostName, remoteOpts);
  if (result.needsAuth) return printHostNeedsAuth(hostName, result);
  if (!result.ok) {
    console.error(`unsnooze prompt clear --host ${hostName}: ${result.error}`);
    return 1;
  }
  console.log(`unsnooze: cleared ${result.cleared} queued prompt(s) on ${hostName}`);
  return 0;
}

async function cmdPromptHost(sub, hostName, args, opts) {
  const hosts = readHosts();
  const entry = hosts[hostName];
  if (!entry) {
    console.error(`unsnooze: no such host: ${hostName}`);
    return 1;
  }
  const remoteOpts = {
    entryOrDest: entry,
    interactive: !!process.stdin.isTTY,
    ...(opts.remote || {}),
  };

  switch (sub) {
    case 'add': return cmdPromptHostAdd(hostName, args, remoteOpts);
    case 'list': return cmdPromptHostList(hostName, args, remoteOpts);
    case 'remove': return cmdPromptHostRemove(hostName, args, remoteOpts);
    case 'clear': return cmdPromptHostClear(hostName, remoteOpts);
    default:
      console.error('unsnooze prompt <add|list|remove|clear> ...');
      return 1;
  }
}

// --- entry point ----------------------------------------------------------

export async function cmdPrompt(rest = [], opts = {}) {
  const [sub, ...args] = rest;
  const { host, rest: cleanArgs, error } = extractHostFlag(args);

  if (error) {
    console.error('unsnooze prompt: --host requires a host name');
    return 1;
  }

  if (host !== undefined) {
    return cmdPromptHost(sub, host, cleanArgs, opts);
  }

  switch (sub) {
    case 'add': return cmdPromptAdd(cleanArgs, opts);
    case 'list': return cmdPromptList(cleanArgs);
    case 'remove': return cmdPromptRemove(cleanArgs);
    case 'clear': return cmdPromptClear();
    default:
      console.error('unsnooze prompt <add|list|remove|clear> ...');
      return 1;
  }
}
