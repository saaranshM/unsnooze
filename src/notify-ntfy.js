// ntfy push channel (https://docs.ntfy.sh) — fire-and-forget phone/desktop
// push that rides ALONGSIDE the local notifyChannel; the whole point is
// reaching a user who is away from the machine.
//
// Dispatch is the JSON-to-root form (POST {server}/ with a JSON body) rather
// than POST-to-/topic with header metadata: every unsnooze title carries an
// emoji, and HTTP headers mangle non-ASCII unless RFC 2047-encoded — JSON
// string values are natively UTF-8. One code path, no escaping.
//
// SECURITY: topics on ntfy.sh are a public namespace — the topic name is
// effectively the password (read AND write for anyone who knows it). Use
// generateNtfyTopic() for an unguessable name, or a self-hosted/authed
// server; ntfyPrivacy=terse keeps cwd paths out of the pushed body entirely.
//
// Same contract as every other notifier: never throws, never blocks the
// detection/resume paths, all deps injectable, no network in tests.

import { randomBytes } from 'node:crypto';
import { getConfig } from './settings.js';

const BODY_MAX = 1024;          // far under ntfy's ~4K push ceiling
const TIMEOUT_MS = 5000;

const TOPIC_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unguessable, ntfy-legal ([-_A-Za-z0-9], <=64 chars) topic name. */
export function generateNtfyTopic() {
  const bytes = randomBytes(16);
  let suffix = '';
  for (const b of bytes) suffix += TOPIC_ALPHABET[b % TOPIC_ALPHABET.length];
  return `unsnooze-${suffix}`;
}

/**
 * Push one notification. Resolution: config/env (ntfyTopic/ntfyServer/
 * ntfyToken/ntfyPrivacy). No topic → quiet no-op. Returns true only on an
 * accepted (2xx) publish; every failure path returns false without throwing.
 */
export async function sendNtfy(title, message, {
  fetcher = globalThis.fetch,
  priority = 3,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  try {
    const topic = getConfig('ntfyTopic');
    if (!topic) return false;
    const server = String(getConfig('ntfyServer') || 'https://ntfy.sh').replace(/\/+$/, '');
    const token = getConfig('ntfyToken');
    const terse = getConfig('ntfyPrivacy') === 'terse';

    // terse: the body may embed cwd paths — never send those to a topic that
    // is only as private as its name. The title alone still tells the story.
    const body = terse
      ? 'details withheld (ntfyPrivacy=terse) — run: unsnooze status'
      : String(message ?? '').slice(0, BODY_MAX);

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetcher(`${server}/`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ topic, title: String(title ?? ''), message: body, priority }),
        signal: ctrl.signal,
      });
      return !!res?.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;   // offline, DNS, 4xx/5xx, abort — never the caller's problem
  }
}
