// Per-pane watcher (`csg _monitor <pane>`), spawned detached by the launcher.
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
import * as realTmux from './tmux.js';
import {
  SCRAPE_INTERVAL_MS, PANE_SCAN_LINES, CAPTURE_LINES, EVENTS_DIR,
  EVENT_MARKER_TTL_MS, OVERLOAD_BACKOFF_S, OVERLOAD_JITTER, OVERLOAD_PATTERNS,
  FALLBACK_RESET_MS, RESET_MARGIN_MS, TMUX_SESSION_NAME,
} from './config.js';
import { detectLimit, isRateLimitOptionsPrompt, menuStepsToWaitOption, isBusy, overloadMatch } from './patterns.js';
import { parseResetTime, resetAtMs } from './time-parser.js';
import { upsertSession, setStatus, readState } from './state.js';
import { latestSessionId } from './sessions.js';
import { spawnResumerIfNeeded } from './spawn.js';
import { makeLogger } from './logger.js';

const log = makeLogger('monitor');

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createMonitor({ pane, cwd, tmux = realTmux, scrapeInterval = SCRAPE_INTERVAL_MS }) {
  let trackedKey = null;      // state key of the record we created
  let overloadAttempt = 0;
  let running = true;

  function markerPath() {
    return join(EVENTS_DIR, `${pane.replace(/[^%\w]/g, '_')}.json`);
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
    const sessionId = latestSessionId(cwd, detectedAt);
    const state = upsertSession({
      sessionId, cwd, pane, tmuxSession: TMUX_SESSION_NAME,
      status: 'stopped', limitType, detectedVia: via, detectedAt,
      resetAt: at, resetSource: source,
      attempts: 0, lastAttemptAt: null, lastError: null,
    });
    trackedKey = sessionId
      || Object.values(state.sessions).find(s => s.pane === pane && s.status === 'stopped')?.key
      || null;
    log(`pane ${pane}: limit recorded (${limitType}, via ${via}), resets ${new Date(at).toISOString()}`);
    spawnResumerIfNeeded();
  }

  async function driveMenu(text) {
    const steps = menuStepsToWaitOption(text, PANE_SCAN_LINES);
    if (steps === null) {
      log(`pane ${pane}: rate-limit menu unreadable — NOT pressing Enter`);
      return false;
    }
    const key = steps > 0 ? 'Down' : 'Up';
    for (let i = 0; i < Math.abs(steps); i++) {
      await tmux.sendKey(pane, key);
      await sleep(120);
    }
    await tmux.sendKey(pane, 'Enter');
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
    const text = await tmux.capturePane(pane, CAPTURE_LINES).catch(() => null);
    if (text === null) return;
    if (isBusy(text)) { log(`pane ${pane}: busy after overload wait — skip inject`); return; }
    if (!overloadMatch(text, OVERLOAD_PATTERNS)) { overloadAttempt = 0; return; }   // recovered on its own
    await tmux.sendText(pane, 'Continue where you left off. The previous attempt failed with a transient API error.');
    log(`pane ${pane}: overload retry message sent`);
  }

  async function tick() {
    if (!(await tmux.paneAlive(pane))) {
      log(`pane ${pane}: gone — monitor exiting (record persists for resumer)`);
      running = false;
      return;
    }

    const marker = consumeMarker();
    let text;
    try {
      text = await tmux.capturePane(pane, CAPTURE_LINES);
    } catch {
      return;   // transient capture failure
    }

    // Interactive menu takes priority — it blocks the session until answered.
    if (isRateLimitOptionsPrompt(text, PANE_SCAN_LINES)) {
      await driveMenu(text);
      return;
    }

    const d = detectLimit(text, PANE_SCAN_LINES);
    if (d.hit) {
      const state = readState();
      const existing = trackedKey && state.sessions[trackedKey];
      if (!existing || existing.status !== 'stopped') {
        await recordLimit(d.resetLine, d.limitType, marker ? 'hook' : 'scrape');
      }
      return;
    }

    // No banner. If we were tracking a stopped record and claude is active
    // again, someone resumed it (user or resumer) — mark it.
    if (trackedKey) {
      const state = readState();
      const rec = state.sessions[trackedKey];
      if (rec && rec.status === 'stopped') {
        setStatus(trackedKey, 'resumed', { lastAttemptAt: Date.now() });
        log(`pane ${pane}: banner cleared, ${trackedKey} marked resumed`);
      }
      if (rec && rec.status !== 'stopped') trackedKey = null;
    }

    // Overload marker (banner-less path).
    if (marker && marker.kind === 'overload') {
      await handleOverload();
    } else if (!marker && overloadMatch(text, OVERLOAD_PATTERNS) && !isBusy(text)) {
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

export async function runMonitor(pane) {
  const cwd = process.env.CSG_CWD || process.cwd();
  const monitor = createMonitor({ pane, cwd });
  await monitor.run();
  return 0;
}
