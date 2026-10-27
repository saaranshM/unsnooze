// Kimi Code 2.x is a separate runtime from the Python kimi-cli. Read its
// workspace metadata and main-agent wire events, never subagent notifications
// or quoted errors. The wire survives /usage overlays and large TUI footers.
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const codeDir = () => process.env.UNSNOOZE_KIMI_CODE_DIR || join(homedir(), '.kimi-code');
const SID = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPONENT = /^[A-Za-z0-9_-]+$/;
export const CODE_LIMIT = /(?:you['’]ve reached your (?:5[- ]hour|weekly|monthly) usage limit|rate_limit_reached_error)/i;

function json(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function codeSessions(cwd, root = codeDir()) {
  const workspaces = json(join(root, 'workspaces.json'))?.workspaces;
  if (!workspaces || typeof workspaces !== 'object') return [];
  const found = [];
  for (const [key, workspace] of Object.entries(workspaces)) {
    if (!COMPONENT.test(key) || typeof workspace?.root !== 'string') continue;
    if (cwd && resolve(workspace.root) !== resolve(cwd)) continue;
    const dir = join(root, 'sessions', key);
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const id of names) {
      if (!SID.test(id)) continue;
      const path = join(dir, id);
      const state = json(join(path, 'state.json'));
      if (state?.id !== id || state.archived || typeof state.cwd !== 'string'
        || resolve(state.cwd) !== resolve(workspace.root)) continue;
      found.push({ id, cwd: state.cwd, path });
    }
  }
  return found;
}

export function codeSession({ cwd, sessionId, pid, root = codeDir() } = {}) {
  if (process.env.UNSNOOZE_KIMI_DIR && !process.env.UNSNOOZE_KIMI_CODE_DIR) return null;
  if (sessionId && !SID.test(sessionId)) return null;
  let candidates = codeSessions(cwd, root);
  if (sessionId) candidates = candidates.filter(s => s.id === sessionId);
  // A pane lease identifies the running process. Do not pick another recent
  // conversation merely because two terminals share a working directory.
  if (pid) candidates = candidates.filter(s => json(join(root, 'locks', 'sessions', `${s.id}.lock`))?.pid === pid);
  return candidates.length === 1 ? candidates[0] : null;
}

export function parseCodeEvent(entry) {
  if (entry?.agentId !== 'main' || !Number.isFinite(entry.time)) return null;
  const at = entry.time;
  if (entry.type === 'turn.ended') {
    const message = typeof entry.error?.message === 'string' ? entry.error.message : '';
    const quota = entry.reason === 'failed' && CODE_LIMIT.test(message)
      && (entry.error?.code === 'provider.api_error' || entry.error?.details?.statusCode === 429);
    return { at, kind: 'end', limit: quota ? {
      hit: true,
      limitType: /5[- ]hour/i.test(message) ? '5h' : /weekly/i.test(message) ? 'weekly' : 'monthly',
      resetLine: message, bannerAt: at,
    } : null };
  }
  if (entry.type === 'usage.record' && Number(entry.usage?.output) > 0) return { at, kind: 'progress' };
  if (entry.type === 'llm.request' || entry.type === 'turn.step.retrying') {
    return { at, kind: 'busy', modelAlias: entry.type === 'llm.request' ? entry.modelAlias : null };
  }
  return null;
}

const cache = new Map();
export function readCodeState(context = {}) {
  const session = codeSession(context);
  if (!session) return null;
  const path = join(session.path, 'agents', 'main', 'wire.jsonl');
  let fd;
  try {
    const { size, mtimeMs } = statSync(path);
    const cached = cache.get(path);
    if (cached?.size === size && cached.mtimeMs === mtimeMs) return cached.value;
    fd = openSync(path, 'r');
    let outcome = null, progressAt = null, activity = null, model = null;
    // Bounded reads, including a second window when a tool result crosses
    // the initial boundary. No full rereads of multi-day transcripts.
    for (let window = 256 * 1024; window <= 4 * 1024 * 1024; window *= 2) {
      const len = Math.min(window, size);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      if (len < size) lines.shift();
      for (const line of lines) {
        let event;
        try { event = parseCodeEvent(JSON.parse(line)); } catch { continue; }
        if (!event) continue;
        if (typeof event.modelAlias === 'string' && (!model || event.at > model.at)) model = event;
        if (!activity || event.at >= activity.at) activity = event;
        if (event.kind === 'end' && (!outcome || event.at >= outcome.at)) outcome = event;
        if (event.kind === 'progress' && (progressAt == null || event.at > progressAt)) progressAt = event.at;
      }
      if (outcome || progressAt != null || len >= size) break;
    }
    const limit = outcome?.limit && (progressAt == null || outcome.at > progressAt) ? outcome.limit : null;
    const value = { sessionId: session.id, limit, progressAt, busy: activity?.kind === 'busy', modelAlias: model?.modelAlias ?? null };
    if (cache.size >= 128) cache.clear();
    cache.set(path, { size, mtimeMs, value });
    return value;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function codeDetection(_text, context) {
  const state = readCodeState(context);
  if (!state) return null; // legacy CLI or unavailable evidence: pane fallback
  return state.limit ? { ...state.limit, sessionId: state.sessionId }
    : { hit: false, limitType: null, resetLine: null, sessionId: state.sessionId };
}

export function hasCodeProgressAfter(rec, afterMs) {
  if (!Number.isFinite(afterMs)) return null;
  const state = readCodeState(rec);
  if (!state) return rec?.sessionId?.startsWith('session_') ? false : null;
  return state.progressAt > afterMs && (!state.limit || state.progressAt > state.limit.bannerAt);
}
