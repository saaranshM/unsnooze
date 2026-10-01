import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-update-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';

const {
  isNewer, updateNotice, whatsNewNotice, changelogSection,
  fetchLatest, runUpdateCheck, runSelfUpdate, readCache, writeCache, PKG_VERSION,
  launchExitNotice, installPrefix,
} = await import('../src/update-check.js');

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
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

// --- which install `unsnooze update` replaces (see installPrefix) ---

const writePkg = (root, version) => {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'unsnooze', version }));
  return root;
};
const versionAt = root => JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;

// npm's own global layout under `prefix`, bin link included.
function npmGlobalInstall(prefix, version) {
  const win = process.platform === 'win32';
  const bin = win ? join(prefix, 'unsnooze.cmd') : join(prefix, 'bin', 'unsnooze');
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, '');
  return writePkg(join(prefix, win ? '' : 'lib', 'node_modules', 'unsnooze'), version);
}

// Stands in for npm: installs under --prefix when given, else its own prefix.
const fakeNpm = (ownPrefix, version) => (cmd, args) => {
  const at = args.indexOf('--prefix');
  npmGlobalInstall(at === -1 ? ownPrefix : args[at + 1], version);
  return { status: 0 };
};

test('runSelfUpdate: replaces the running copy, not the one in npm\'s default prefix', () => {
  const running = npmGlobalInstall(join(DIR, 'two-prefixes', 'local'), '1.0.0');
  const lines = [];
  const code = runSelfUpdate({
    runner: fakeNpm(join(DIR, 'two-prefixes', 'nvm'), '1.1.0'),
    print: l => lines.push(l), root: running, current: '1.0.0',
  });
  assert.equal(code, 0);
  assert.equal(versionAt(running), '1.1.0', 'the copy that is running must be the one updated');
  assert.match(lines.join('\n'), /updated to 1\.1\.0/);
});

test('runSelfUpdate: a copy npm did not install globally keeps npm\'s default prefix', () => {
  // A git checkout, npm link, npx or a pnpm global: no prefix to name.
  const calls = [];
  runSelfUpdate({
    runner: (cmd, args) => { calls.push([cmd, ...args]); return { status: 0 }; },
    print: () => {}, root: writePkg(join(DIR, 'checkout', 'unsnooze'), '1.0.0'), current: '1.0.0',
  });
  assert.deepEqual(calls, [['npm', 'install', '-g', 'unsnooze@latest']]);
});

test('runSelfUpdate: never says "already up to date" when a newer version is known and this copy did not change', () => {
  writeCache({ lastCheckedAt: Date.now(), latest: '1.1.0' });
  const lines = [];
  const code = runSelfUpdate({
    runner: fakeNpm(join(DIR, 'stale', 'elsewhere'), '1.1.0'),
    print: l => lines.push(l), root: writePkg(join(DIR, 'stale', 'unsnooze'), '1.0.0'), current: '1.0.0',
  });
  const out = lines.join('\n');
  assert.notEqual(code, 0, 'an update that did not reach this copy is not a success');
  assert.doesNotMatch(out, /already up to date/);
  assert.match(out, /still 1\.0\.0 and 1\.1\.0 is out/);
});

test('installPrefix: names the prefix only for an npm global install', () => {
  const have = paths => p => paths.includes(p);
  assert.equal(
    installPrefix({ root: '/home/u/.local/lib/node_modules/unsnooze', platform: 'linux',
      exists: have(['/home/u/.local/bin/unsnooze']) }),
    '/home/u/.local');
  assert.equal(
    installPrefix({ root: 'C:\\Users\\U\\AppData\\Roaming\\npm\\node_modules\\unsnooze', platform: 'win32',
      exists: have(['C:\\Users\\U\\AppData\\Roaming\\npm\\unsnooze.cmd']) }),
    'C:\\Users\\U\\AppData\\Roaming\\npm');
  // Same layout but npm never linked a bin there: not npm's global install.
  assert.equal(installPrefix({ root: '/home/u/.local/lib/node_modules/unsnooze', platform: 'linux',
    exists: () => false }), null);
  // A git checkout, a project dependency, an npx cache and a pnpm global.
  for (const root of ['/home/u/src/unsnooze', '/home/u/app/node_modules/unsnooze',
    '/home/u/.npm/_npx/0a1b/node_modules/unsnooze', '/home/u/.local/share/pnpm/global/5/node_modules/unsnooze']) {
    assert.equal(installPrefix({ root, platform: 'linux', exists: () => true }), null, root);
  }
});

// --- post-session-exit notice (wrapper-only users never run `unsnooze status`,
// so the launch path is the one place a notice reliably reaches them) ---

test('launchExitNotice: fires for a newer version and stamps lastNoticeAt', () => {
  writeCache({ lastCheckedAt: Date.now(), latest: '999.0.0' });
  const now = Date.now();
  const notice = launchExitNotice({ now });
  assert.match(notice, /999\.0\.0 is available/);
  assert.equal(readCache().lastNoticeAt, now, 'must stamp so the next launch stays quiet');
});

test('launchExitNotice: at most once per day', () => {
  const now = Date.now();
  writeCache({ lastCheckedAt: now, latest: '999.0.0', lastNoticeAt: now - 3_600_000 });
  assert.equal(launchExitNotice({ now }), null, 'an hour-old notice suppresses');
  writeCache({ lastNoticeAt: now - 25 * 3_600_000 });
  assert.match(launchExitNotice({ now }), /999\.0\.0/, 'a day-old notice fires again');
});

test('launchExitNotice: silent when current, unchecked, or updateCheck is off', () => {
  assert.equal(launchExitNotice(), null, 'no cache → silent');
  writeCache({ lastCheckedAt: Date.now(), latest: PKG_VERSION });
  assert.equal(launchExitNotice(), null, 'up to date → silent');
  writeCache({ latest: '999.0.0' });
  process.env.UNSNOOZE_UPDATE_CHECK = 'off';
  assert.equal(launchExitNotice(), null, 'updateCheck off → silent');
});
