// Session-file watcher — the tmux-free detection channel. Tails the files the
// agent CLIs already write (Claude Code transcripts, Codex rollouts) for
// limit-stop evidence, so sessions running in GUI surfaces (VS Code extension,
// desktop apps) are tracked even though there is no pane to scrape and no
// shell wrapper in the launch path. Records land in the same ledger with
// pane-less records the resumer already reopens by session id.
//
// Offset semantics: on a cold start (no offsets file) every existing file
// starts at EOF — history is never replayed as fresh stops. Files that appear
// later are read from the start (a stop that happened while the daemon was
// down is still a real stop); the freshness window drops anything old.

import {
  readdirSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync,
  openSync, readSync, closeSync,
} from 'node:fs';
import { join, sep, basename, dirname } from 'node:path';
import {
  CLAUDE_DIR, CODEX_DIR, WATCH_OFFSETS_FILE, WATCH_FRESHNESS_MS,
  RESET_MARGIN_MS, FALLBACK_RESET_MS, TMUX_SESSION_NAME,
} from './config.js';
import { parseTranscriptLine } from './watchers/claude.js';
import { parseRolloutLine, rolloutMeta } from './watchers/codex.js';
import { ROLLOUT_RE } from './agents/codex.js';
import { parseResetTime, resetAtMs } from './time-parser.js';
import { upsertSession } from './state.js';
import { getConfig } from './settings.js';
import { notify } from './notify.js';
import { makeLogger } from './logger.js';

const log = makeLogger('watcher');

const MAX_WALK_DEPTH = 8;
// A file first seen mid-run is read from the start, but never more than this —
// a giant transcript is history, and the freshness window drops it anyway.
const MAX_READ_BYTES = 10 * 1024 * 1024;

export function claudeSource({ roots }) {
  return {
    agent: 'claude',
    roots,
    enabled: () => getConfig('agents.claude'),
    // Subagent transcripts live under <session>/subagents/ — their limit
    // entries duplicate the parent session's own entry.
    match: p => p.endsWith('.jsonl') && !p.split(sep).includes('subagents'),
    parse(lines) {
      return lines
        .map(parseTranscriptLine)
        .filter(Boolean)
        .map(rec => ({
          agent: 'claude',
          sessionId: rec.sessionId,
          cwd: rec.cwd,
          limitType: rec.limitType,
          resetLine: rec.resetLine,
          resetAt: null,
          origin: rec.entrypoint,
          timestampMs: rec.timestampMs,
        }));
    },
  };
}

export function codexSource({ roots }) {
  return {
    agent: 'codex',
    roots,
    enabled: () => getConfig('agents.codex'),
    match: p => ROLLOUT_RE.test(basename(p)),
    parse(lines, path) {
      const hits = lines.map(parseRolloutLine).filter(Boolean);
      if (hits.length === 0) return [];
      const last = hits[hits.length - 1];   // the latest snapshot governs
      const meta = rolloutMeta(path);
      return [{
        agent: 'codex',
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        limitType: last.limitType,
        resetLine: null,
        resetAt: last.resetAt,
        origin: meta.originator,
        timestampMs: last.timestampMs,
      }];
    },
  };
}

export function defaultSources() {
  return [
    claudeSource({ roots: [join(CLAUDE_DIR, 'projects')] }),
    codexSource({ roots: [join(CODEX_DIR, 'sessions')] }),
  ];
}

// Turn a watcher candidate into a ledger record. No pane key at all — a merge
// into an existing scrape/hook record must never clobber a live pane id.
export function dispatchCandidate(c) {
  const detectedAt = c.timestampMs || Date.now();
  let at, source;
  if (c.resetAt) {
    ({ at, source } = { at: c.resetAt + RESET_MARGIN_MS, source: 'absolute' });
  } else {
    ({ at, source } = resetAtMs(parseResetTime(c.resetLine), {
      marginMs: RESET_MARGIN_MS, fallbackMs: FALLBACK_RESET_MS,
    }));
  }
  upsertSession({
    sessionId: c.sessionId || null,
    cwd: c.cwd || null,
    agent: c.agent,
    origin: c.origin || null,
    tmuxSession: TMUX_SESSION_NAME,
    status: 'stopped',
    limitType: c.limitType || 'unknown',
    detectedVia: 'transcript',
    detectedAt,
    resetAt: at,
    resetSource: source,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
  });
  log(`limit stop via transcript: agent=${c.agent} session=${c.sessionId || '?'} origin=${c.origin || '?'} resetAt=${new Date(at).toISOString()} (${source})`);
  notify('limit hit 😴', `${c.cwd || c.agent}: tracked — resumes when the limit resets`);
}

function loadOffsets(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readRange(path, from, to) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const len = Math.min(to - from, MAX_READ_BYTES);
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, from + read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function createWatcher({
  sources = defaultSources(),
  offsetsPath = WATCH_OFFSETS_FILE,
  freshnessMs = WATCH_FRESHNESS_MS,
  onStop = dispatchCandidate,
  now = Date.now,
} = {}) {
  let offsets = loadOffsets(offsetsPath);
  let coldStart = offsets === null;
  if (coldStart) offsets = {};

  function saveOffsets(seen) {
    for (const key of Object.keys(offsets)) {
      if (!seen.has(key)) delete offsets[key];   // rotated/deleted files
    }
    try {
      mkdirSync(dirname(offsetsPath), { recursive: true });
      const tmp = join(dirname(offsetsPath), `.offsets.tmp.${process.pid}`);
      writeFileSync(tmp, JSON.stringify(offsets));
      renameSync(tmp, offsetsPath);
    } catch (err) {
      log(`offsets save failed: ${err.message}`);
    }
  }

  // Appended complete lines since the last tick, advancing the stored offset.
  // All offset math in bytes (a \n byte can't occur inside a multibyte char).
  function readAppended(path) {
    let size;
    try { size = statSync(path).size; } catch { return null; }
    const known = Object.prototype.hasOwnProperty.call(offsets, path);
    let offset;
    if (!known) {
      if (coldStart) { offsets[path] = size; return null; }
      offset = Math.max(0, size - MAX_READ_BYTES);
    } else {
      offset = offsets[path];
    }
    if (size < offset) { offsets[path] = size; return null; }   // rewritten shorter
    if (size === offset) { offsets[path] = size; return null; }
    const buf = readRange(path, offset, size);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) { offsets[path] = offset; return null; }  // partial line — wait
    offsets[path] = offset + lastNl + 1;
    return buf.subarray(0, lastNl + 1).toString('utf-8').split('\n').filter(l => l.trim());
  }

  function walk(dir, depth, cb) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < MAX_WALK_DEPTH) walk(p, depth + 1, cb);
        continue;
      }
      if (e.isFile()) cb(p);
    }
  }

  return {
    async tick() {
      const seen = new Set();
      const candidates = [];
      for (const source of sources) {
        if (source.enabled && !source.enabled()) continue;
        for (const root of source.roots) {
          walk(root, 0, path => {
            if (!source.match(path)) return;
            seen.add(path);
            const lines = readAppended(path);
            if (!lines || lines.length === 0) return;
            try {
              candidates.push(...source.parse(lines, path));
            } catch (err) {
              log(`parse error in ${path}: ${err.message}`);
            }
          });
        }
      }
      coldStart = false;
      saveOffsets(seen);
      const fresh = candidates.filter(c => c.timestampMs == null || now() - c.timestampMs <= freshnessMs);
      for (const c of fresh) {
        try { onStop(c); } catch (err) { log(`onStop failed: ${err.message}`); }
      }
      return fresh.length;
    },
  };
}
