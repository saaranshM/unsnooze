import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-update-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';

const {
  isNewer, updateNotice, whatsNewNotice, changelogSection,
  fetchLatest, runUpdateCheck, runSelfUpdate, readCache, writeCache, PKG_VERSION,
} = await import('../src/update-check.js');

after(() => rmSync(DIR, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(join(DIR, 'update-check.json'), { force: true });
  delete process.env.UNSNOOZE_UPDATE_CHECK;
});

test('isNewer: plain x.y.z comparison, garbage never wins', () => {
  assert.equal(isNewer('1.4.0', '1.3.0'), true);
  assert.equal(isNewer('1.3.0', '1.3.0'), false);
  assert.equal(isNewer('1.3.0', '1.4.0'), false);
  assert.equal(isNewer('2.0.0', '1.9.9'), true);
  assert.equal(isNewer('1.10.0', '1.9.0'), true);
  assert.equal(isNewer('banana', '1.0.0'), false);
  assert.equal(isNewer('1.0.0-beta.1', '1.0.0'), false);
  assert.equal(isNewer(null, '1.0.0'), false);
});

test('updateNotice: silent with no cache, speaks when latest is newer', () => {
  assert.equal(updateNotice('1.3.0'), null);
  writeCache({ lastCheckedAt: Date.now(), latest: '1.4.0' });
  const notice = updateNotice('1.3.0');
  assert.match(notice, /1\.4\.0 is available/);
  assert.match(notice, /you have 1\.3\.0/);
  assert.match(notice, /unsnooze update/);
  assert.equal(updateNotice('1.4.0'), null, 'no notice when up to date');
});

test('updateNotice: updateCheck=off silences everything', () => {
  writeCache({ lastCheckedAt: Date.now(), latest: '9.9.9' });
  process.env.UNSNOOZE_UPDATE_CHECK = 'off';
  assert.equal(updateNotice('1.0.0'), null);
});

test('changelogSection returns the bundled section for the current version', () => {
  const section = changelogSection(PKG_VERSION);
  assert.ok(section && section.length > 0, `no changelog section for ${PKG_VERSION}`);
  assert.ok(!section.includes(`## ${PKG_VERSION}`), 'heading itself is stripped');
});

test('whatsNewNotice: records on first run, speaks once after an update', () => {
  assert.equal(whatsNewNotice('1.3.0'), null, 'first ever run is silent');
  assert.equal(readCache().lastRunVersion, '1.3.0');
  const notice = whatsNewNotice(PKG_VERSION);
  assert.match(notice, new RegExp(`Updated to ${PKG_VERSION.replace(/\./g, '\\.')}`));
  assert.equal(whatsNewNotice(PKG_VERSION), null, 'only speaks once');
});

test('fetchLatest: returns version, and null on HTTP errors/timeouts without throwing', async () => {
  const okFetch = async () => ({ ok: true, json: async () => ({ version: '2.1.0' }) });
  assert.equal(await fetchLatest({ fetcher: okFetch }), '2.1.0');
  const failFetch = async () => ({ ok: false, status: 503 });
  assert.equal(await fetchLatest({ fetcher: failFetch }), null);
  const throwFetch = async () => { throw new Error('network down'); };
  assert.equal(await fetchLatest({ fetcher: throwFetch }), null);
});

test('runUpdateCheck: caches, toasts ONCE per new version', async () => {
  const toasts = [];
  const fetcher = async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) });
  await runUpdateCheck({ fetcher, notifier: (t, m) => toasts.push(`${t} ${m}`) });
  assert.equal(readCache().latest, '9.9.9');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /9\.9\.9/);
  await runUpdateCheck({ fetcher, notifier: (t, m) => toasts.push(`${t} ${m}`) });
  assert.equal(toasts.length, 1, 'second sighting of the same version stays quiet');
});

test('runUpdateCheck: updateCheck=off never fetches', async () => {
  process.env.UNSNOOZE_UPDATE_CHECK = 'off';
  let fetched = false;
  await runUpdateCheck({ fetcher: async () => { fetched = true; }, notifier: () => {} });
  assert.equal(fetched, false);
});

test('runSelfUpdate: runs npm install -g and reports the new version', () => {
  const calls = [];
  const lines = [];
  const code = runSelfUpdate({
    runner: (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { status: 0 }; },
    print: l => lines.push(l),
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /npm install -g unsnooze@latest/);
  assert.match(lines.join('\n'), /Updated to \d+\.\d+\.\d+|already up to date/i);
});

test('runSelfUpdate: surfaces npm failure with a hint, non-zero exit', () => {
  const lines = [];
  const code = runSelfUpdate({
    runner: () => ({ status: 243 }),
    print: l => lines.push(l),
  });
  assert.notEqual(code, 0);
  assert.match(lines.join('\n'), /npm install -g unsnooze/);
});
