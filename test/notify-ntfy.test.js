// ntfy push channel — ADDITIVE to the local notifyChannel (a phone push
// complements the desktop toast; the whole point is reaching an absent user).
// JSON-POST-to-root form: titles carry emoji, and header-based titles mangle
// non-ASCII unless RFC 2047-encoded — JSON body strings are natively UTF-8.

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-ntfy-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { sendNtfy, generateNtfyTopic } = await import('../src/notify-ntfy.js');
const { notify } = await import('../src/notify.js');
const { DEFAULTS } = await import('../src/settings.js');

after(() => rmSync(DIR, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(join(DIR, 'config.json'), { force: true });
  for (const k of ['UNSNOOZE_NTFY_TOPIC', 'UNSNOOZE_NTFY_SERVER', 'UNSNOOZE_NTFY_TOKEN', 'UNSNOOZE_NTFY_PRIVACY', 'UNSNOOZE_NOTIFICATIONS']) {
    delete process.env[k];
  }
});

function fakeFetch(status = 200) {
  const calls = [];
  const fetcher = async (url, opts) => { calls.push({ url, opts }); return { ok: status < 400, status }; };
  fetcher.calls = calls;
  return fetcher;
}

test('config keys exist with safe defaults (off until a topic is set)', () => {
  assert.equal(DEFAULTS.ntfyTopic, '');
  assert.equal(DEFAULTS.ntfyServer, 'https://ntfy.sh');
  assert.equal(DEFAULTS.ntfyToken, '');
  assert.equal(DEFAULTS.ntfyPrivacy, 'full');
});

test('sendNtfy posts JSON to the server ROOT with topic/title/message in the body', async () => {
  process.env.UNSNOOZE_NTFY_TOPIC = 'unsnooze-abc123';
  const fetcher = fakeFetch();
  const ok = await sendNtfy('unsnoozed ✅', '/tmp/proj is running again', { fetcher });
  assert.equal(ok, true);
  assert.equal(fetcher.calls.length, 1);
  const { url, opts } = fetcher.calls[0];
  assert.equal(url, 'https://ntfy.sh/');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers['Content-Type'], 'application/json');
  const body = JSON.parse(opts.body);
  assert.equal(body.topic, 'unsnooze-abc123');
  assert.equal(body.title, 'unsnoozed ✅', 'emoji survives — JSON, not headers');
  assert.equal(body.message, '/tmp/proj is running again');
  assert.equal(body.priority, 3);
  assert.equal(opts.headers.Authorization, undefined, 'no auth header without a token');
});

test('sendNtfy honors server override (trailing slash tolerated), token, and priority', async () => {
  process.env.UNSNOOZE_NTFY_TOPIC = 't';
  process.env.UNSNOOZE_NTFY_SERVER = 'http://localhost:8080/';
  process.env.UNSNOOZE_NTFY_TOKEN = 'tk_7eevizlsiwf9yi4uxsrs83r4352o0';
  const fetcher = fakeFetch();
  await sendNtfy('t', 'm', { fetcher, priority: 4 });
  const { url, opts } = fetcher.calls[0];
  assert.equal(url, 'http://localhost:8080/');
  assert.equal(opts.headers.Authorization, 'Bearer tk_7eevizlsiwf9yi4uxsrs83r4352o0');
  assert.equal(JSON.parse(opts.body).priority, 4);
});

test('sendNtfy is a silent no-op without a topic, and never throws on network failure', async () => {
  const fetcher = fakeFetch();
  assert.equal(await sendNtfy('t', 'm', { fetcher }), false, 'no topic → off');
  assert.equal(fetcher.calls.length, 0);

  process.env.UNSNOOZE_NTFY_TOPIC = 't';
  const boom = async () => { throw new Error('offline'); };
  assert.equal(await sendNtfy('t', 'm', { fetcher: boom }), false, 'network error swallowed');
  const notOk = fakeFetch(429);
  assert.equal(await sendNtfy('t', 'm', { fetcher: notOk }), false, '429 → false, no throw');
});

test('terse privacy strips the body (paths never reach a public topic)', async () => {
  process.env.UNSNOOZE_NTFY_TOPIC = 't';
  process.env.UNSNOOZE_NTFY_PRIVACY = 'terse';
  const fetcher = fakeFetch();
  await sendNtfy('unsnoozed ✅', '/Users/alice/secret-startup is running again', { fetcher });
  const body = JSON.parse(fetcher.calls[0].opts.body);
  assert.doesNotMatch(body.message, /secret-startup/, 'cwd never sent in terse mode');
  assert.ok(body.message.length > 0, 'still says something actionable');
});

test('oversized bodies are capped well under the 4K push limit', async () => {
  process.env.UNSNOOZE_NTFY_TOPIC = 't';
  const fetcher = fakeFetch();
  await sendNtfy('t', 'x'.repeat(5000), { fetcher });
  assert.ok(JSON.parse(fetcher.calls[0].opts.body).message.length <= 1024);
});

test('notify() fires ntfy ADDITIVELY alongside the local channel', async () => {
  process.env.UNSNOOZE_NTFY_TOPIC = 'topic';
  const fetcher = fakeFetch();
  const spawns = [];
  notify('title', 'message', {
    platform: 'darwin',
    spawner: (cmd, args) => spawns.push({ cmd, args }),
    ntfyFetcher: fetcher,
  });
  await new Promise(r => setTimeout(r, 20));   // fire-and-forget settles
  assert.equal(spawns.length, 1, 'local toast still fires');
  assert.equal(fetcher.calls.length, 1, 'push fires too');
});

test('notifications=false master switch silences ntfy as well', async () => {
  process.env.UNSNOOZE_NTFY_TOPIC = 'topic';
  process.env.UNSNOOZE_NOTIFICATIONS = 'off';
  const fetcher = fakeFetch();
  notify('t', 'm', { platform: 'darwin', spawner: () => {}, ntfyFetcher: fetcher });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(fetcher.calls.length, 0);
});

test('generateNtfyTopic makes unguessable, ntfy-legal topic names', () => {
  const a = generateNtfyTopic();
  const b = generateNtfyTopic();
  assert.match(a, /^unsnooze-[-_A-Za-z0-9]{16}$/);
  assert.ok(a.length <= 64, 'within ntfy topic limit');
  assert.notEqual(a, b, 'random');
});
