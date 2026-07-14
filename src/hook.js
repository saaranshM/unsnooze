// StopFailure hook handler (`unsnooze _hook-stopfailure [--agent <id>]`).
// The agent CLI (Claude Code, or Grok Build via its Claude-compatible hooks)
// invokes this with JSON on stdin when a turn ends in failure matching the
// configured matcher (overloaded|server_error|rate_limit).
// Must exit 0 quickly and never block or crash the calling CLI.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVENTS_DIR, FALLBACK_RESET_MS, RESET_MARGIN_MS, CAPTURE_LINES, PANE_SCAN_LINES } from './config.js';
import { detectLimit } from './patterns.js';
import { getAgent } from './agents/index.js';
import { getConfig } from './settings.js';
import { parseResetTime, resetAtMs } from './time-parser.js';
import { upsertSession } from './state.js';
import { getMultiplexer } from './multiplexer.js';
import { spawnResumerIfNeeded } from './spawn.js';
import { makeLogger } from './logger.js';
import { addressHash } from './lease.js';

const log = makeLogger('hook');

function readStdin(timeoutMs = 2000) {
  return new Promise(resolve => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

function classify(payload, raw) {
  const hay = JSON.stringify(payload) + raw;
  if (/rate.?limit|usage.?limit/i.test(hay)) return 'rate_limit';
  if (/overloaded|server_error|529|503/i.test(hay)) return 'overload';
  return 'unknown';
}

export async function runHook(rest = []) {
  try {
    const agentIdx = rest.indexOf('--agent');
    const agent = getAgent(agentIdx !== -1 ? rest[agentIdx + 1] : 'claude');
    if (!getConfig(`agents.${agent.id}`)) return 0;   // agent disabled in settings
    const raw = await readStdin();
    let payload = {};
    try { payload = JSON.parse(raw); } catch { /* tolerate non-JSON */ }

    const managedMux = process.env.UNSNOOZE_MUX;
    const muxName = managedMux || (process.env.ZELLIJ_PANE_ID ? 'zellij' : 'tmux');
    const pane = managedMux
      ? (process.env.UNSNOOZE_PANE || null)
      : (muxName === 'zellij' ? process.env.ZELLIJ_PANE_ID : process.env.TMUX_PANE || payload.tmux_pane) || null;
    const paneOwner = muxName === 'zellij'
      ? (managedMux ? process.env.UNSNOOZE_PANE_OWNER : process.env.ZELLIJ_SESSION_NAME) || null
      : null;
    const leaseId = process.env.UNSNOOZE_LEASE_ID || null;
    const mux = getMultiplexer(muxName, { owner: paneOwner });
    const kind = classify(payload, raw);
    log(`StopFailure: kind=${kind} pane=${pane} session=${payload.session_id || '?'}`);

    if (kind === 'overload') {
      // Seconds-scale problem — leave a marker for the pane's monitor, do NOT
      // record in state.json.
      if (pane) {
        mkdirSync(EVENTS_DIR, { recursive: true });
        writeFileSync(join(EVENTS_DIR, `${addressHash({ mux: muxName, paneOwner, pane })}.json`),
          JSON.stringify({ mux: muxName, paneOwner, pane, kind, at: Date.now(), payload: { error: payload.error ?? null } }));
      }
      return 0;
    }

    // rate_limit (or unknown — treat conservatively as a limit if we can see a banner)
    const cwd = payload.cwd || process.cwd();
    const detectedAt = Date.now();
    let resetLine = null;
    let limitType = 'unknown';
    if (pane) {
      try {
        const text = await mux.capturePane(pane, CAPTURE_LINES);
        const d = detectLimit(text, PANE_SCAN_LINES, agent.patterns);
        if (d.hit) { resetLine = d.resetLine; limitType = d.limitType; }
      } catch { /* pane not capturable (no tmux) — fall back below */ }
    }

    if (kind === 'unknown' && !resetLine) return 0;   // nothing actionable

    const { at, source } = resetAtMs(parseResetTime(resetLine), {
      marginMs: RESET_MARGIN_MS, fallbackMs: FALLBACK_RESET_MS,
    });
    const sessionId = payload.session_id || agent.latestSessionId(cwd, detectedAt);

    // Discover the live session name from the pane — never freeze the module
    // load-time MUX_SESSION_NAME constant onto the record.
    let muxSession = null;
    if (pane && typeof mux.sessionForPane === 'function') {
      try { muxSession = await mux.sessionForPane(pane); } catch { muxSession = null; }
    }

    upsertSession({
      sessionId: sessionId || null,
      cwd,
      pane,
      mux: muxName,
      paneOwner,
      leaseId,
      agent: agent.id,
      origin: 'cli',   // the hook only fires for CLI launches we can see
      muxSession,
      status: 'stopped',
      limitType,
      detectedVia: 'hook',
      detectedAt,
      resetAt: at,
      resetSource: source,
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    });
    log(`recorded limit stop: session=${sessionId} resetAt=${new Date(at).toISOString()} (${source})`);
    spawnResumerIfNeeded();
    return 0;
  } catch (err) {
    log(`hook error (swallowed): ${err.stack || err}`);
    return 0;   // never fail the hook
  }
}
