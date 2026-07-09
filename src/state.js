// Shared multi-writer state store: ~/.unsnooze/state.json.
// Writers: N monitors, the StopFailure hook, the resumer, CLI subcommands.
// Safety: mkdir-based lock (atomic on POSIX) around read-modify-write, tmp
// file + rename for atomic replacement, stale-lock stealing, corrupt-file
// quarantine. All synchronous — callers are short-lived or infrequent.

import {
  mkdirSync, rmdirSync, readFileSync, writeFileSync, renameSync,
  existsSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  STATE_DIR, STATE_FILE, LOCK_DIR, STALE_LOCK_MS, PRUNE_AFTER_MS,
  DEDUPE_WINDOW_MS,
} from './config.js';
import { makeLogger } from './logger.js';

const log = makeLogger('state');

const EMPTY = () => ({ version: 1, resumerPid: null, sessions: {} });

function sleepSync(ms) {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

function acquireLock() {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') { mkdirSync(STATE_DIR, { recursive: true }); continue; }
      try {
        const age = Date.now() - statSync(LOCK_DIR).mtimeMs;
        if (age > STALE_LOCK_MS) {
          rmdirSync(LOCK_DIR);   // steal stale lock from a killed process
          log(`stole stale lock (age ${Math.round(age)}ms)`);
          continue;
        }
      } catch { /* lock vanished between check and stat — retry */ }
      if (Date.now() > deadline) throw new Error('unsnooze: state lock timeout after 5s');
      sleepSync(50);
    }
  }
}

function releaseLock() {
  try { rmdirSync(LOCK_DIR); } catch { /* already gone */ }
}

export function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return EMPTY();
    // Corrupt file: quarantine loudly, start fresh — never crash the hook path.
    try {
      const quarantine = `${STATE_FILE}.corrupt.${Date.now()}`;
      renameSync(STATE_FILE, quarantine);
      log(`CORRUPT state.json quarantined to ${quarantine}: ${err.message}`);
    } catch { /* someone else quarantined it first */ }
    return EMPTY();
  }
}

// Locked read-modify-write. mutator receives the state object and mutates it
// (or returns a replacement). Returns the final state.
export function updateState(mutator) {
  mkdirSync(STATE_DIR, { recursive: true });
  acquireLock();
  try {
    const state = readState();
    const result = mutator(state) ?? state;
    const tmp = join(STATE_DIR, `.state.tmp.${process.pid}`);
    writeFileSync(tmp, JSON.stringify(result, null, 2));
    renameSync(tmp, STATE_FILE);
    return result;
  } finally {
    releaseLock();
  }
}

// Insert or update a session record. Dedupes hook-vs-scrape double detection:
// if a record for the same pane was created within DEDUPE_WINDOW_MS, merge into
// it (a record WITH a sessionId wins over one without).
export function upsertSession(record) {
  return updateState(state => {
    prune(state);
    const existingKey = findDuplicate(state, record);
    if (existingKey) {
      const existing = state.sessions[existingKey];
      const merged = {
        ...existing,
        ...record,
        // Never downgrade a known sessionId to null.
        sessionId: record.sessionId || existing.sessionId,
        key: existingKey,
      };
      state.sessions[existingKey] = merged;
      log(`merged duplicate detection for pane ${record.pane} into ${existingKey}`);
      return state;
    }
    const key = record.sessionId || `pane:${record.pane}:${record.detectedAt}`;
    state.sessions[key] = { ...record, key };
    return state;
  });
}

function findDuplicate(state, record) {
  if (record.sessionId && state.sessions[record.sessionId]) return record.sessionId;
  for (const [key, s] of Object.entries(state.sessions)) {
    if (s.pane && s.pane === record.pane
      && s.status === 'stopped'
      && Math.abs((s.detectedAt || 0) - record.detectedAt) < DEDUPE_WINDOW_MS) {
      return key;
    }
  }
  return null;
}

export function setStatus(key, status, extra = {}) {
  return updateState(state => {
    const s = state.sessions[key];
    if (!s) return state;
    Object.assign(s, extra, { status });
    return state;
  });
}

function prune(state) {
  const cutoff = Date.now() - PRUNE_AFTER_MS;
  for (const [key, s] of Object.entries(state.sessions)) {
    const terminal = ['resumed', 'failed', 'cancelled'].includes(s.status);
    const ts = s.lastAttemptAt || s.detectedAt || 0;
    if (terminal && ts < cutoff) delete state.sessions[key];
  }
}

export function activeStopped(state = readState()) {
  return Object.values(state.sessions).filter(s => s.status === 'stopped');
}

export function dueSessions(now = Date.now(), state = readState()) {
  return activeStopped(state).filter(s => (s.resetAt || 0) <= now);
}
