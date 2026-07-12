// Per-pane watcher (`unsnooze _monitor <pane>`), spawned detached by the launcher.
// Responsibilities:
//   - scrape the pane every SCRAPE_INTERVAL_MS for a live limit banner or the
//     /rate-limit-options menu; on limit → record in state + spawn resumer
//   - consume overload event markers from the StopFailure hook and run the
//     seconds-scale backoff retry ladder (never touches state.json)
//   - flip a tracked record to 'resumed' if the user/resumer got things moving
//   - exit when the pane dies
// tmux + timers are injectable for tests.

import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getMultiplexer } from './multiplexer.js';
import {
  SCRAPE_INTERVAL_MS, PANE_SCAN_LINES, CAPTURE_LINES, EVENTS_DIR,
  EVENT_MARKER_TTL_MS, OVERLOAD_BACKOFF_S, OVERLOAD_JITTER,
  FALLBACK_RESET_MS, RESET_MARGIN_MS, MUX_SESSION_NAME,
} from './config.js';
import { detectLimit, isBusy, overloadMatch } from './patterns.js';
import { getAgent } from './agents/index.js';
import { getConfig } from './settings.js';
import { notify } from './notify.js';
import { parseResetTime, resetAtMs } from './time-parser.js';
import { upsertSession, setStatus, readState } from './state.js';
import { spawnResumerIfNeeded } from './spawn.js';
import { makeLogger } from './logger.js';
import { addressHash } from './lease.js';

const log = makeLogger('monitor');

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createMonitor({
  muxName = 'tmux', paneOwner = null, pane, leaseId = null, cwd,
  agent = getAgent('claude'), mux = getMultiplexer(muxName, { owner: paneOwner }),
  scrapeInterval = SCRAPE_INTERVAL_MS, notifier = notify,
}) {
  let trackedKey = null;      // state key of the record we created
  let overloadAttempt = 0;
  let terminalNotified = false;   // one notification per terminal-error appearance
  let running = true;

  function markerPath() {
    return join(EVENTS_DIR, `${addressHash({ mux: muxName, paneOwner, pane })}.json`);
  }

  function consumeMarker() {
    try {
      const marker = JSON.parse(readFileSync(markerPath(), 'utf-8'));
      unlinkSync(markerPath());
      if (Date.now() - marker.at > EVENT_MARKER_TTL_MS) return null;   // stale
      return marker;
    } catch {
      return null;
    }
  }

  async function recordLimit(resetLine, limitType, via) {
    const detectedAt = Date.now();
    const { at, source } = resetAtMs(parseResetTime(resetLine), {
      marginMs: RESET_MARGIN_MS, fallbackMs: FALLBACK_RESET_MS,
    });
    const sessionId = agent.latestSessionId(cwd, detectedAt);
    const state = upsertSession({
      sessionId, cwd, pane, mux: muxName, paneOwner, leaseId,
      agent: agent.id, muxSession: MUX_SESSION_NAME,
      status: 'stopped', limitType, detectedVia: via, detectedAt,
      resetAt: at, resetSource: source,
      attempts: 0, lastAttemptAt: null, lastError: null,
    });
    trackedKey = sessionId
      || Object.values(state.sessions).find(s => s.mux === muxName
        && s.paneOwner === paneOwner && s.pane === pane
        && ['stopped', 'resuming', 'resumed'].includes(s.status))?.key
      || null;
    log(`pane ${pane}: limit recorded (${limitType}, via ${via}), resets ${new Date(at).toISOString()}`);
    notify(`${agent.name} hit a usage limit`, `${cwd} — auto-resume at ${new Date(at).toLocaleTimeString()}`);
    spawnResumerIfNeeded();
  }

  async function driveMenu(text) {
    const steps = agent.menu.stepsToWait(text, PANE_SCAN_LINES);
    if (steps === null) {
      log(`pane ${pane}: rate-limit menu unreadable — NOT pressing Enter`);
      return false;
    }
    const key = steps > 0 ? 'Down' : 'Up';
    for (let i = 0; i < Math.abs(steps); i++) {
      await mux.sendKey(pane, key);
      await sleep(120);
    }
    await mux.sendKey(pane, 'Enter');
    log(`pane ${pane}: selected "Stop and wait for limit to reset" (${steps} steps)`);
    await sleep(1000);
    // After selection the TUI prints the limit banner — next scrape records it.
    return true;
  }

  async function handleOverload() {
    if (overloadAttempt >= OVERLOAD_BACKOFF_S.length) {
      log(`pane ${pane}: overload retries exhausted`);
      overloadAttempt = 0;   // reset ladder; next marker starts fresh
      return;
    }
    const base = OVERLOAD_BACKOFF_S[overloadAttempt] * 1000;
    const jitter = base * OVERLOAD_JITTER * (Math.random() * 2 - 1);
    const wait = Math.round(base + jitter);
    overloadAttempt++;
    log(`pane ${pane}: overload — retry ${overloadAttempt}/${OVERLOAD_BACKOFF_S.length} in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
    if (!running) return;
    const text = await mux.capturePane(pane, CAPTURE_LINES).catch(() => null);
    if (text === null) return;
    if (isBusy(text, agent.patterns.busyPatterns)) { log(`pane ${pane}: busy after overload wait — skip inject`); return; }
    if (!overloadMatch(text, agent.patterns.overloadPatterns)) { overloadAttempt = 0; return; }   // recovered on its own
    await mux.sendText(pane, 'Continue where you left off. The previous attempt failed with a transient API error.');
    log(`pane ${pane}: overload retry message sent`);
  }

  async function tick() {
    if (!(await mux.paneAlive(pane))) {
      log(`pane ${pane}: gone — monitor exiting (record persists for resumer)`);
      running = false;
      return;
    }

    const marker = consumeMarker();
    let text;
    try {
      text = await mux.capturePane(pane, CAPTURE_LINES);
    } catch {
      return;   // transient capture failure
    }

    // Interactive menu takes priority — it blocks the session until answered.
    // Checked against the VISIBLE screen only: a menu in scrollback history
    // was already answered, and re-driving it would inject stray keys.
    const visible = mux.capturePaneVisible
      ? await mux.capturePaneVisible(pane).catch(() => '')
      : text;
    if (agent.menu && agent.menu.isPrompt(visible, PANE_SCAN_LINES)) {
      if (!getConfig('menuAutoAnswer')) {
        // Watch-only mode: record the stop (reset time may not be visible
        // until the menu is answered — fallback covers that), touch nothing.
        const state = readState();
        const existing = trackedKey && state.sessions[trackedKey];
        if (!existing || existing.status !== 'stopped') {
          const d = detectLimit(text, PANE_SCAN_LINES, agent.patterns);
          log(`pane ${pane}: limit menu detected but menuAutoAnswer is off — recording only`);
          await recordLimit(d.hit ? d.resetLine : null, d.hit ? d.limitType : 'unknown', 'scrape');
        }
        return;
      }
      await driveMenu(visible);
      return;
    }

    const d = detectLimit(text, PANE_SCAN_LINES, agent.patterns);
    if (d.hit) {
      const state = readState();
      const existing = trackedKey && state.sessions[trackedKey];
      if (!existing || existing.status !== 'stopped') {
        await recordLimit(d.resetLine, d.limitType, marker ? 'hook' : 'scrape');
      }
      return;
    }

    // Non-resetting terminal errors (credits exhausted, membership expired,
    // discontinued tiers): notify once per appearance, never touch the ledger —
    // there is no reset to wait for. Re-arms when the error clears.
    const term = overloadMatch(text, agent.patterns.terminalPatterns || []);
    if (term) {
      if (!terminalNotified) {
        terminalNotified = true;
        notifier(`${agent.name} needs attention ⚠️`, `${cwd} — ${term.line}`);
        log(`pane ${pane}: terminal error (no auto-resume): ${term.line}`);
      }
    } else {
      terminalNotified = false;
    }

    // No banner. If we were tracking a stopped record and claude is active
    // again, someone resumed it (user or resumer) — mark it.
    if (trackedKey) {
      const state = readState();
      const rec = state.sessions[trackedKey];
      if (rec && rec.status === 'stopped') {
        setStatus(trackedKey, 'resumed', { lastAttemptAt: Date.now(), bannerCleared: true });
        log(`pane ${pane}: banner cleared, ${trackedKey} marked resumed`);
        trackedKey = null;
      }
      if (rec && rec.status === 'resumed') {
        setStatus(trackedKey, 'resumed', { bannerCleared: true });
        trackedKey = null;
      } else if (rec && rec.status !== 'stopped') trackedKey = null;
    }

    // Overload marker (banner-less path).
    if (marker && marker.kind === 'overload') {
      await handleOverload();
    } else if (!marker && overloadMatch(text, agent.patterns.overloadPatterns) && !isBusy(text, agent.patterns.busyPatterns)) {
      await handleOverload();
    }
  }

  return {
    async run() {
      log(`monitor started for pane ${pane} (cwd ${cwd})`);
      while (running) {
        await tick();
        if (!running) break;
        await sleep(scrapeInterval);
      }
    },
    stop() { running = false; },
    _tick: tick,   // exposed for tests
    get trackedKey() { return trackedKey; },
  };
}

export async function runMonitor(muxName, paneOwner, pane, agentId, leaseId) {
  const cwd = process.env.UNSNOOZE_CWD || process.cwd();
  const monitor = createMonitor({ muxName, paneOwner: paneOwner || null, pane, leaseId, cwd, agent: getAgent(agentId) });
  await monitor.run();
  return 0;
}
