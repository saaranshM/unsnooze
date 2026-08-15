// Proof that unsnooze created a multiplexer session.
//
// `unsnooze reap` deletes sessions it believes are its own, and until now the
// only evidence was the name: anything matching `unsnooze` / `unsnooze-N` was
// fair game. That is a guess, not ownership. On tmux and zellij the blast
// radius was small — an empty session — but herdr keeps stopped sessions
// listed, so a user's own stopped session called `unsnooze-9` was stopped and
// deleted on sight.
//
// A name is not proof, so we write proof down. Deliberately one small file per
// session rather than a field in state.json: sessions are created by the
// launcher, in the hot path, from processes that may never write state at all,
// and state.json is a single lock-guarded document shared with the daemon.
// Same reasoning as leases, and the same atomic write.

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { STATE_DIR } from './config.js';

const SESSIONS_DIR = () => join(process.env.UNSNOOZE_STATE_DIR || STATE_DIR, 'mux-sessions');

function recordPath(mux, name) {
  const key = createHash('sha256').update(`${mux ?? ''}\0${name ?? ''}`).digest('hex');
  return join(SESSIONS_DIR(), `${key}.json`);
}

export function recordOwnedSession({ mux, name }) {
  if (!mux || !name) return null;
  const record = { mux, name, createdAt: Date.now(), pid: process.pid };
  try {
    mkdirSync(SESSIONS_DIR(), { recursive: true });
    const path = recordPath(mux, name);
    const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, path);
    return record;
  } catch {
    // Never fail a launch over bookkeeping. The cost of a missing record is a
    // session reap declines to clean, which is the safe direction.
    return null;
  }
}

export function ownsSession(mux, name) {
  try {
    return JSON.parse(readFileSync(recordPath(mux, name), 'utf-8')).name === name;
  } catch {
    return false;
  }
}

export function forgetSession(mux, name) {
  try { unlinkSync(recordPath(mux, name)); } catch { /* already gone */ }
}

export function listOwnedRecords() {
  try {
    return readdirSync(SESSIONS_DIR())
      .filter(file => file.endsWith('.json'))
      .map(file => {
        try { return JSON.parse(readFileSync(join(SESSIONS_DIR(), file), 'utf-8')); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
