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
  PROBE_INTERVAL_MS, RESET_MARGIN_MS,
} from './config.js';
import { detectLimit, isBusy, overloadMatch } from './patterns.js';
import { getAgent } from './agents/index.js';
import { getConfig } from './settings.js';
import { notify } from './notify.js';
import { parseResetTime, resetAtMs, sourceRank } from './time-parser.js';
import { upsertSession, setStatus, readState, updateState } from './state.js';
import { latestRateLimitFromTranscript } from './watchers/claude.js';
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
  const notifyCtx = { mux: muxName, pane, paneOwner };
  let trackedKey = null;      // state key of the record we created
  let overloadAttempt = 0;
  let terminalNotified = false;   // one notification per terminal-error appearance
  let running = true;
  let firstTick = true;           // §6: don't inherit a previous session's banner

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

  // Prefer a dated transcript entry when the agent keeps one (claude).
  function resolveBanner(paneResetLine, paneLimitType) {
    const detectedAt = Date.now();
    const sessionId = agent.latestSessionId?.(cwd, detectedAt) || null;
    const fromTx = latestRateLimitFromTranscript(cwd, sessionId, { now: detectedAt });
    if (fromTx) {
      return {
        resetLine: fromTx.resetLine ?? paneResetLine,
        limitType: fromTx.limitType && fromTx.limitType !== 'unknown' ? fromTx.limitType : paneLimitType,
        bannerAt: fromTx.timestampMs,
        sessionId: fromTx.sessionId || sessionId,
        via: 'transcript',
        detectedAt,
      };
    }
    return {
      resetLine: paneResetLine,
      limitType: paneLimitType,
      bannerAt: null,
      sessionId,
      via: null,   // filled by caller (scrape/hook)
      detectedAt,
    };
  }

  function computeReset(resetLine, bannerAt, detectedAt) {
    return resetAtMs(parseResetTime(resetLine), {
      marginMs: RESET_MARGIN_MS,
      fallbackMs: PROBE_INTERVAL_MS,
      now: new Date(detectedAt),
      bannerAt,
    });
  }

  // §6 first-tick corroboration: only record if a fresh transcript backs it,
  // or an absolute clock time resolves to a still-future instant (not the
  // "already past → due now" path, which is margin above wall clock only).
  function isCorroborated(resolved, at, source) {
    if (resolved.via === 'transcript' && resolved.bannerAt != null) return true;
    if (source === 'absolute' && at - RESET_MARGIN_MS > Date.now()) return true;
    return false;
  }

  // §7: upgrade a weak estimate (fallback/relative) when a better value
  // becomes available. A strictly better source (e.g. fallback→absolute)
  // always wins — absolute is truth even if later than a probe guess.
  // Same-or-worse source may only pull the wake earlier, never push it later.
  function maybeUpgrade(existing, at, source, bannerAt, limitType, via) {
    if (!existing || existing.status !== 'stopped') return false;
    const oldRank = sourceRank(existing.resetSource);
    const newRank = sourceRank(source);
    const betterSource = newRank > oldRank;
    const earlier = at < existing.resetAt;
    if (!betterSource && !earlier) return false;
    if (!betterSource && at > existing.resetAt) return false;
    updateState(state => {
      const s = state.sessions[existing.key];
      if (!s || s.status !== 'stopped') return;
      s.resetAt = at;
      s.resetSource = source;
      if (bannerAt != null) s.bannerAt = bannerAt;
      if (limitType && limitType !== 'unknown') s.limitType = limitType;
      if (via) s.detectedVia = via;
      if (source !== 'fallback') delete s.probeCount;
    });
    log(`pane ${pane}: upgraded reset ${existing.resetSource}→${source} at ${new Date(at).toISOString()}`);
    return true;
  }

  async function recordLimit(resetLine, limitType, via) {
    const resolved = resolveBanner(resetLine, limitType);
    const detectedVia = resolved.via || via;
    const { at, source } = computeReset(resolved.resetLine, resolved.bannerAt, resolved.detectedAt);
    let muxSession = null;
    if (typeof mux.sessionForPane === 'function') {
      try { muxSession = await mux.sessionForPane(pane); } catch { muxSession = null; }
    }
    const state = upsertSession({
      sessionId: resolved.sessionId, cwd, pane, mux: muxName, paneOwner, leaseId,
      agent: agent.id, muxSession,
      status: 'stopped', limitType: resolved.limitType, detectedVia,
      detectedAt: resolved.detectedAt,
      bannerAt: resolved.bannerAt,
      resetAt: at, resetSource: source,
      attempts: 0, lastAttemptAt: null, lastError: null,
      ...(source === 'fallback' ? { probeCount: 0 } : {}),
    });
    trackedKey = resolved.sessionId
      || Object.values(state.sessions).find(s => s.mux === muxName
        && s.paneOwner === paneOwner && s.pane === pane
        && ['stopped', 'resuming', 'resumed'].includes(s.status))?.key
      || null;
    log(`pane ${pane}: limit recorded (${resolved.limitType}, via ${detectedVia}), resets ${new Date(at).toISOString()} (${source})`);
    notifier(`${agent.name} hit a usage limit`, `${cwd} — auto-resume at ${new Date(at).toLocaleTimeString()}`, { context: notifyCtx });
    spawnResumerIfNeeded();
    return { at, source, resolved };
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
        firstTick = false;
        return;
      }
      await driveMenu(visible);
      firstTick = false;
      return;
    }

    const d = detectLimit(text, PANE_SCAN_LINES, agent.patterns);
    if (d.hit) {
      const state = readState();
      const existing = trackedKey && state.sessions[trackedKey];

      // §7: still-stopped records can upgrade a weak estimate.
      if (existing && existing.status === 'stopped') {
        const resolved = resolveBanner(d.resetLine, d.limitType);
        const via = resolved.via || (marker ? 'hook' : 'scrape');
        const { at, source } = computeReset(resolved.resetLine, resolved.bannerAt, resolved.detectedAt);
        maybeUpgrade(existing, at, source, resolved.bannerAt, resolved.limitType, via);
        firstTick = false;
        return;
      }

      if (!existing || existing.status !== 'stopped') {
        const via = marker ? 'hook' : 'scrape';
        // §6: first tick needs corroboration so we don't inherit a leftover banner.
        if (firstTick) {
          const resolved = resolveBanner(d.resetLine, d.limitType);
          const detectedVia = resolved.via || via;
          const { at, source } = computeReset(resolved.resetLine, resolved.bannerAt, resolved.detectedAt);
          if (!isCorroborated({ ...resolved, via: detectedVia }, at, source)) {
            log(`pane ${pane}: first tick banner uncorroborated (${source}) — skipping`);
            firstTick = false;
            return;
          }
          // Reuse recordLimit path; resolveBanner is idempotent enough.
          await recordLimit(d.resetLine, d.limitType, via);
          firstTick = false;
          return;
        }
        await recordLimit(d.resetLine, d.limitType, via);
      }
      firstTick = false;
      return;
    }

    // Non-resetting terminal errors (credits exhausted, membership expired,
    // discontinued tiers): notify once per appearance, never touch the ledger —
    // there is no reset to wait for. Re-arms when the error clears.
    const term = overloadMatch(text, agent.patterns.terminalPatterns || []);
    if (term) {
      if (!terminalNotified) {
        terminalNotified = true;
        notifier(`${agent.name} needs attention ⚠️`, `${cwd} — ${term.line}`, { context: notifyCtx });
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

    firstTick = false;
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
    get _firstTick() { return firstTick; },
  };
}

export async function runMonitor(muxName, paneOwner, pane, agentId, leaseId) {
  const cwd = process.env.UNSNOOZE_CWD || process.cwd();
  const monitor = createMonitor({ muxName, paneOwner: paneOwner || null, pane, leaseId, cwd, agent: getAgent(agentId) });
  await monitor.run();
  return 0;
}
