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
  openSync, readSync, closeSync, existsSync,
} from 'node:fs';
import { join, sep, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import {
  CLAUDE_DIR, CODEX_DIR, WATCH_OFFSETS_FILE, WATCH_FRESHNESS_MS,
  RESET_MARGIN_MS, FALLBACK_RESET_MS, MUX_SESSION_NAME,
} from './config.js';
import { getMultiplexer } from './multiplexer.js';
import { parseTranscriptLine } from './watchers/claude.js';
import { parseRolloutLine, rolloutMeta } from './watchers/codex.js';
import { ROLLOUT_RE } from './agents/codex.js';
import { parseResetTime, resetAtMs } from './time-parser.js';
import { upsertSession, readState, updateState } from './state.js';
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

// Claude desktop (cowork) sessions are sandboxed: each runs against an
// isolated CLAUDE_CONFIG_DIR at <session>/local_<id>/.claude, so the global
// hook never fires and the transcripts live outside ~/.claude. Reviving one
// needs that same CLAUDE_CONFIG_DIR exported — carried on the record as env —
// plus CLAUDE_SECURESTORAGE_CONFIG_DIR='' so auth stays on the DEFAULT
// keychain entry: the service name is otherwise derived from the config dir,
// and the sandbox holds no credentials (verified against a real cowork
// session: with the pair set, `claude -p --resume <id>` answers; without the
// override it dies with "Not logged in").
// Experimental: desktop worktree/VM sessions may still differ.
export function claudeDesktopSource({ roots }) {
  const base = claudeSource({ roots });
  return {
    ...base,
    parse(lines, path) {
      const configDir = configDirFromPath(path);
      return base.parse(lines, path).map(rec => ({
        ...rec,
        origin: 'desktop',
        env: configDir
          ? { CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }
          : undefined,
      }));
    },
  };
}

function configDirFromPath(path) {
  const marker = `${sep}.claude${sep}`;
  const idx = path.indexOf(marker);
  return idx === -1 ? null : path.slice(0, idx + marker.length - 1);
}

export function defaultSources() {
  const sources = [
    claudeSource({ roots: [join(CLAUDE_DIR, 'projects')] }),
    codexSource({ roots: [join(CODEX_DIR, 'sessions')] }),
  ];
  if (process.platform === 'darwin') {
    sources.push(claudeDesktopSource({
      roots: [process.env.UNSNOOZE_CLAUDE_DESKTOP_DIR
        || join(homedir(), 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions')],
    }));
  }
  return sources;
}

// Turn a watcher candidate into a ledger record. No pane key at all — a merge
// into an existing scrape/hook record must never clobber a live pane id.
//
// The same stop is re-emitted whenever the CLI appends another limit line (a
// GUI auto-retry, or the revived session hitting the still-active limit), so
// an existing record's lifecycle must be respected: an active record only
// gets its reset time refreshed — never its status/attempts reset, or the
// MAX_RESUME_ATTEMPTS cap could never bind — and a cancelled record stays
// cancelled.
export function dispatchCandidate(c) {
  const detectedAt = c.timestampMs || Date.now();
  let at, source;
  if (c.resetAt) {
    at = c.resetAt + RESET_MARGIN_MS;
    source = 'absolute';
  } else {
    ({ at, source } = resetAtMs(parseResetTime(c.resetLine), {
      marginMs: RESET_MARGIN_MS, fallbackMs: FALLBACK_RESET_MS,
    }));
  }

  const existing = c.sessionId
    ? Object.values(readState().sessions).find(s => s.sessionId === c.sessionId)
    : null;
  if (existing && existing.status === 'cancelled') return;
  if (existing && (existing.status === 'stopped' || existing.status === 'resuming')) {
    updateState(state => {
      const s = state.sessions[existing.key];
      if (s && (s.status === 'stopped' || s.status === 'resuming')) {
        s.resetAt = at;
        s.resetSource = source;
        if (c.limitType && c.limitType !== 'unknown') s.limitType = c.limitType;
      }
    });
    log(`refreshed reset for tracked stop: session=${c.sessionId} resetAt=${new Date(at).toISOString()}`);
    return;
  }

  const record = {
    sessionId: c.sessionId || null,
    cwd: c.cwd || null,
    agent: c.agent,
    origin: c.origin || null,
    mux: getMultiplexer().name, paneOwner: null, leaseId: null,
    muxSession: MUX_SESSION_NAME,
    status: 'stopped',
    limitType: c.limitType || 'unknown',
    detectedVia: 'transcript',
    detectedAt,
    resetAt: at,
    resetSource: source,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
  };
  if (c.env) record.env = c.env;   // e.g. CLAUDE_CONFIG_DIR for sandboxed desktop sessions
  upsertSession(record);
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
  let dirty = coldStart;

  function setOffset(path, value) {
    if (offsets[path] !== value) { offsets[path] = value; dirty = true; }
  }

  function saveOffsets(seen) {
    // Unseen ≠ gone: a source may be disabled this tick or a root transiently
    // unreadable — wiping those offsets would replay history on re-enable.
    // Only forget files that no longer exist.
    for (const key of Object.keys(offsets)) {
      if (!seen.has(key) && !existsSync(key)) { delete offsets[key]; dirty = true; }
    }
    if (!dirty) return;
    try {
      mkdirSync(dirname(offsetsPath), { recursive: true });
      const tmp = join(dirname(offsetsPath), `.offsets.tmp.${process.pid}`);
      writeFileSync(tmp, JSON.stringify(offsets));
      renameSync(tmp, offsetsPath);
      dirty = false;
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
      if (coldStart) { setOffset(path, size); return null; }
      offset = Math.max(0, size - MAX_READ_BYTES);
    } else {
      offset = offsets[path];
    }
    // Nothing new, or rewritten shorter (rotate/truncate) — pin to EOF.
    if (size <= offset) { setOffset(path, size); return null; }
    const buf = readRange(path, offset, size);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) { setOffset(path, offset); return null; }  // partial line — wait
    setOffset(path, offset + lastNl + 1);
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
      // Strict freshness: a candidate without a parseable timestamp cannot be
      // dated, and dispatching it risks reviving a long-finished session (the
      // offsets can legitimately replay old lines after a file reappears).
      // Every real transcript/rollout line carries an ISO timestamp.
      const fresh = [];
      for (const c of candidates) {
        if (Number.isFinite(c.timestampMs) && now() - c.timestampMs <= freshnessMs) fresh.push(c);
        else log(`dropped stale/undatable candidate: agent=${c.agent} session=${c.sessionId || '?'} ts=${c.timestampMs}`);
      }
      for (const c of fresh) {
        try { onStop(c); } catch (err) { log(`onStop failed: ${err.message}`); }
      }
      return fresh.length;
    },
  };
}
