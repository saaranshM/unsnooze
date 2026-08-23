// Regression tests for the 1.17.0 hardening pass (issue #17 verification).
//
// Most cases pin a behaviour that was wrong before: the lock loop spinning
// forever on an unwritable state dir, releaseLock dropping a lock it no
// longer owned, the corrupt-state log echoing the file's own bytes, and
// everything under ~/.unsnooze being world-readable.
//
// A few deliberately do NOT fail against the old code, and say so in place:
// they guard the new behaviour against over-correction (a releaseLock that
// refuses to release, a staleness ceiling that steals live locks, a repair
// that reaches outside the state dir) or characterise a property the code
// has always had.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, statSync, lstatSync, chmodSync, mkdirSync, writeFileSync,
  readFileSync, existsSync, symlinkSync, linkSync, utimesSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-harden-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { updateState, readState, upsertSession } = await import('../src/state.js');
const { ensureStateDir } = await import('../src/config.js');

after(() => {
  try { chmodSync(DIR, 0o700); } catch { /* already writable */ }
  rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const mode = p => statSync(p).mode & 0o777;

// Everything under `dir` that any other local user could read, one level deep.
function tooOpenUnder(dir) {
  const out = [];
  const visit = (p, rel) => {
    const st = statSync(p);
    if ((st.mode & 0o077) !== 0) out.push(`${(st.mode & 0o777).toString(8)} ${rel}`);
    if (st.isDirectory()) for (const n of readdirSync(p)) visit(join(p, n), `${rel}/${n}`);
  };
  visit(dir, '.');
  return out;
}
// chmod is a no-op on Windows (node only carries the read-only bit there),
// so the permission expectations are POSIX-only.
const posix = process.platform !== 'win32';

test('ensureStateDir creates the state dir owner-only', { skip: !posix }, () => {
  const d = join(DIR, 'fresh-dir');
  ensureStateDir(d);
  assert.equal(mode(d), 0o700);
});

test('ensureStateDir repairs a pre-existing world-readable state dir', { skip: !posix }, () => {
  // Repair applies to OUR state dir specifically — see the foreign-directory
  // test below for the other half of that rule.
  chmodSync(DIR, 0o755);
  assert.equal(mode(DIR), 0o755, 'precondition: the 0755 an older version left');
  ensureStateDir();
  assert.equal(mode(DIR), 0o700);
});

test('state.json is written owner-only', { skip: !posix }, () => {
  updateState(s => { s.sessions.perm = { key: 'perm' }; return s; });
  assert.equal(mode(join(DIR, 'state.json')), 0o600);
  assert.equal(mode(DIR), 0o700, 'the state dir itself must be owner-only too');
});

test('a state.json rewrite repairs a pre-existing 0644 file', { skip: !posix }, () => {
  const f = join(DIR, 'state.json');
  chmodSync(f, 0o644);
  updateState(s => { s.sessions.perm2 = { key: 'perm2' }; return s; });
  assert.equal(mode(f), 0o600, 'tmp+rename must carry 0600 over the old file');
});

test('corrupt state.json is quarantined without echoing its bytes into the log', () => {
  const f = join(DIR, 'state.json');
  // V8 truncates the echoed input to TEN characters, so the probe has to fit
  // inside that budget — a longer secret would never appear in the message
  // even on the leaky code, and the assertion would prove nothing.
  const probe = 'SUPRSECRET';
  assert.equal(probe.length, 10);
  writeFileSync(f, `${probe}_and_more, definitely not json`);
  const state = readState();
  assert.deepEqual(state.sessions, {}, 'corrupt file still starts a fresh state');

  const logText = readFileSync(join(DIR, 'unsnooze.log'), 'utf-8');
  const corruptLines = logText.split('\n').filter(l => l.includes('CORRUPT state.json'));
  assert.ok(corruptLines.length > 0, 'the quarantine must still be logged loudly');
  const last = corruptLines[corruptLines.length - 1];
  assert.ok(!last.includes(probe),
    `V8 embeds the parsed input in its JSON.parse message; it must not reach the log: ${last}`);
  assert.ok(!/Unexpected token/.test(last),
    `the whole V8 message must be kept out, not just the part that happens to be secret: ${last}`);
  assert.ok(last.includes('SyntaxError'), 'the reason is still reported, minus the content');
});

test('a state.json symlink is never written through', { skip: !posix }, () => {
    // Deliberately narrow, because the broader claim is false: readState uses
    // readFileSync, which FOLLOWS the link — the target below holds valid
    // JSON and its contents ARE read as state. That is not a privilege
    // boundary: planting the symlink needs write access to a 0700 directory,
    // and anyone with that owns the account already. What IS guaranteed is
    // the write side: updateState's tmp+rename replaces the link with a real
    // file rather than writing through it, so the target is never truncated
    // or overwritten.
    // The target holds VALID JSON deliberately. With a non-JSON target the
    // quarantine renames the link away before any write happens, so the write
    // path never sees a symlink and the assertion below proves nothing.
    const d = mkdtempSync(join(tmpdir(), 'unsnooze-symlink-'));
    const secret = join(d, 'secret.txt');
    writeFileSync(secret, '{"version":1,"secret":"KEY MATERIAL","sessions":{}}');
    symlinkSync(secret, join(d, 'state.json'));

    const script = `
      process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(d)};
      const { readState, updateState } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/state.js')).href)});
      console.log(JSON.stringify(readState().sessions));
      updateState(s => { s.sessions.probe = { key: 'probe' }; return s; });
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(out.trim(), '{}', 'the target is read, but carries no sessions of its own');
    assert.equal(readFileSync(secret, 'utf-8'), '{"version":1,"secret":"KEY MATERIAL","sessions":{}}',
      'the pointed-at file is never truncated or written through');
    assert.ok(!lstatSync(join(d, 'state.json')).isSymbolicLink(),
      'the write replaced the link with a real file rather than following it');
    rmSync(d, { recursive: true, force: true });
  });

test('releaseLock leaves behind a lock that was stolen from us mid-write', () => {
  // updateState calls acquireLock() OUTSIDE its try/finally, so a writer that
  // never gets the lock never reaches releaseLock — the only way to exercise
  // it is from inside the critical section. Here the mutator plays the thief
  // exactly as acquireLock's steal does (remove the dir, recreate it, stamp a
  // foreign pid); the finally must then leave that new lock alone.
  const lock = join(DIR, 'state.lock');
  rmSync(lock, { recursive: true, force: true });
  let out;
  try {
    out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(DIR)};
    const { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { updateState } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/state.js')).href)});
    const lock = join(${JSON.stringify(DIR)}, 'state.lock');
    updateState(s => {
      // a concurrent stale-lock steal robs us while we are inside
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), '999999');
      return s;
    });
    console.log(JSON.stringify({
      survived: existsSync(join(lock, 'pid')),
      owner: existsSync(join(lock, 'pid')) ? readFileSync(join(lock, 'pid'), 'utf-8') : null,
    }));
  `], { encoding: 'utf8' });
  } finally {
    // The child deliberately leaves a foreign lock behind; if it failed for
    // any other reason the lock is still there, and every later test in this
    // file would time out waiting for it. Clean up either way.
    rmSync(lock, { recursive: true, force: true });
  }
  const r = JSON.parse(out.trim());
  assert.equal(r.survived, true, "releaseLock must not delete a lock it no longer owns");
  assert.equal(r.owner, '999999', "and must leave the thief's stamp intact");
});

test('releaseLock still drops a lock that is ours', () => {
  // A guard on the new pid check, not a regression test — it passes against
  // the old code too. It exists so a releaseLock that over-refuses (and so
  // leaks the lock) cannot pass while the test above still does.
  const lock = join(DIR, 'state.lock');
  rmSync(lock, { recursive: true, force: true });
  updateState(s => s);
  assert.ok(!existsSync(lock), 'the normal path must not leak the lock');
});

test('an unwritable-but-owned state dir is repaired instead of spinning forever',
  { skip: !posix || process.getuid?.() === 0 }, () => {
    // The 1.16.3 bug: mkdir(LOCK_DIR) returns EACCES, which is not EEXIST, and
    // that branch retried with neither a sleep nor a deadline check — so this
    // spun at ~70% CPU forever, ignoring LOCK_TIMEOUT_MS, in every writer.
    const d = mkdtempSync(join(tmpdir(), 'unsnooze-nolock-'));
    writeFileSync(join(d, 'state.json'), '{"version":1,"sessions":{}}');
    chmodSync(d, 0o500);   // readable + traversable, NOT writable
    const started = Date.now();
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(d)};
        process.env.UNSNOOZE_LOCK_TIMEOUT_MS = '500';
        const { updateState } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/state.js')).href)});
        updateState(s => { s.sessions.ok = { key: 'ok' }; return s; });
      `], { stdio: 'pipe', timeout: 20_000 });
      assert.ok(Date.now() - started < 15_000, 'must not hot-loop');
      assert.equal(mode(d), 0o700, 'ensureStateDir repaired the mode it owns');
    } finally {
      chmodSync(d, 0o700);
      rmSync(d, { recursive: true, force: true });
    }
  });

test('a lock path that can never be created fails by deadline, not by spinning',
  { skip: !posix }, () => {
    // The same branch, where the repair cannot help. STATE_DIR is grown to sit
    // exactly at the OS path limit, so it is creatable but STATE_DIR/state.lock
    // overflows — mkdir returns ENAMETOOLONG no matter how often it is retried.
    // Verified against the pre-fix code: it spun until killed at 6s.
    const d0 = mkdtempSync(join(tmpdir(), 'unsnooze-nolock2-'));
    let d = d0;
    for (;;) {
      const n = join(d, 'x'.repeat(200));
      try { mkdirSync(n); d = n; } catch { break; }
    }
    for (let pad = 199; pad > 0; pad--) {
      const n = join(d, 'y'.repeat(pad));
      try { mkdirSync(n); d = n; break; } catch { /* still too long */ }
    }
    // Guard a filesystem whose NAME_MAX is below 200 (eCryptfs is 143): the
    // probe would make no progress and the lock path would be creatable, so
    // there would be nothing to assert. Check the real condition, not a
    // length arithmetic stand-in for it.
    let overflows = false;
    try {
      mkdirSync(join(d, 'state.lock'));
      rmSync(join(d, 'state.lock'), { recursive: true, force: true });
    } catch (e) {
      overflows = e.code === 'ENAMETOOLONG';
    }
    if (!overflows) {
      rmSync(d0, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      return;
    }
    const started = Date.now();
    try {
      assert.throws(
        () => execFileSync(process.execPath, ['--input-type=module', '-e', `
          process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(d)};
          process.env.UNSNOOZE_LOCK_TIMEOUT_MS = '500';
          const { updateState } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/state.js')).href)});
          updateState(s => s);
        `], { stdio: 'pipe', timeout: 20_000 }),
        /cannot create state lock/,
        'an unfixable errno must surface as an error, not a hot loop',
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 15_000, `must give up on the deadline, not spin (took ${elapsed}ms)`);
    } finally {
      rmSync(d0, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

// --- the rest of ~/.unsnooze -------------------------------------------------

test('config.json is written owner-only — it carries the ntfy bearer token',
  { skip: !posix }, async () => {
    const { setConfigValue } = await import('../src/settings.js');
    setConfigValue('ntfyToken', 'tk_TEST_BEARER');
    const f = join(DIR, 'config.json');
    assert.match(readFileSync(f, 'utf-8'), /tk_TEST_BEARER/);
    assert.equal(mode(f), 0o600);
  });

test('hosts.json is written owner-only — it carries credential-source commands',
  { skip: !posix }, async () => {
    const { writeHosts } = await import('../src/fleet.js');
    writeHosts({ box: { dest: 'box', auth: 'password', source: 'command', cmd: 'pass show box' } });
    assert.equal(mode(join(DIR, 'hosts.json')), 0o600);
  });

test('the fleet cache is written owner-only — it mirrors remote cwds and prompts',
  { skip: !posix }, async () => {
    const { writeFleetCache } = await import('../src/fleet.js');
    writeFleetCache([{ host: 'box', state: 'ok', sessions: [] }]);
    assert.equal(mode(join(DIR, 'fleet-cache.json')), 0o600);
  });

test('a leftover same-pid tmp file cannot carry its mode onto the target',
  { skip: !posix }, () => {
    // writeFileSync's `mode` lands only when it CREATES the file. A tmp left
    // by a crashed predecessor that shared this pid is reused, so without the
    // chmod after the rename its 0644 rode straight onto state.json.
    updateState(s => s);
    const tmp = join(DIR, `.state.tmp.${process.pid}`);
    writeFileSync(tmp, 'leftover');
    chmodSync(tmp, 0o644);
    updateState(s => { s.sessions.reuse = { key: 'reuse' }; return s; });
    assert.equal(mode(join(DIR, 'state.json')), 0o600);
  });

test('an existing 0644 config.json is repaired without waiting to be rewritten',
  { skip: !posix }, async () => {
    // config.json is only written by `config set`, so an upgraded install
    // would otherwise keep its 0644 (and its ntfy token) indefinitely.
    const d = mkdtempSync(join(tmpdir(), 'unsnooze-repair-'));
    writeFileSync(join(d, 'config.json'), '{"ntfyToken":"tk_legacy"}');
    chmodSync(join(d, 'config.json'), 0o644);
    chmodSync(d, 0o755);
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(d)};
      const { updateState } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/state.js')).href)});
      updateState(s => s);   // any state write repairs the dir's known files
      const { statSync } = await import('node:fs');
      const m = p => (statSync(p).mode & 0o777).toString(8);
      console.log(JSON.stringify({ dir: m(${JSON.stringify(d)}), cfg: m(${JSON.stringify(join(d, 'config.json'))}) }));
    `], { encoding: 'utf8' });
    const r = JSON.parse(out.trim());
    assert.equal(r.cfg, '600', 'the token file is narrowed on the next state write');
    assert.equal(r.dir, '700');
    rmSync(d, { recursive: true, force: true });
  });

test('a lock stamped with a live but unrelated pid is stolen past the hard ceiling', () => {
  // lockHolderAlive() can only ask "is this pid alive". A leaked lock whose
  // pid is recycled onto some unrelated long-lived process used to wedge
  // every writer forever; past the ceiling, age alone wins.
  const lock = join(DIR, 'state.lock');
  try {
  rmSync(lock, { recursive: true, force: true });
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(process.pid));   // very much alive
  const old = new Date(Date.now() - 30 * 24 * 3_600_000);  // 30 days
  utimesSync(lock, old, old);

  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(DIR)};
    process.env.UNSNOOZE_LOCK_TIMEOUT_MS = '2000';
    const { updateState } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/state.js')).href)});
    updateState(s => { s.sessions.unwedged = { key: 'unwedged' }; return s; });
    console.log('acquired');
  `], { encoding: 'utf8' });
  assert.equal(out.trim(), 'acquired');
  assert.ok(readState().sessions.unwedged, 'the write actually landed');
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
});

test('a stale-but-live lock inside the ceiling is still respected', () => {
  // The ceiling must not become a licence to steal live locks. This has to be
  // aged PAST the ordinary staleness gate (10s) but inside the ceiling
  // (300s) — a fresh lock short-circuits on `age > STALE_LOCK_MS` and never
  // consults HARD_STALE_LOCK_MS at all, so it proves nothing about it.
  const lock = join(DIR, 'state.lock');
  try {
  rmSync(lock, { recursive: true, force: true });
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(process.pid));   // very much alive
  const aged = new Date(Date.now() - 15_000);              // > 10s, << 300s
  utimesSync(lock, aged, aged);
  assert.throws(
    () => execFileSync(process.execPath, ['--input-type=module', '-e', `
      process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(DIR)};
      process.env.UNSNOOZE_LOCK_TIMEOUT_MS = '300';
      const { updateState } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/state.js')).href)});
      updateState(s => s);
    `], { stdio: 'pipe' }),
    /lock timeout/,
    'a live holder inside the ceiling must never be robbed',
  );
  assert.equal(readFileSync(join(lock, 'pid'), 'utf-8'), String(process.pid),
    'and its stamp is untouched');
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
});

test('every writer creates its state-dir entry owner-only', { skip: !posix }, async () => {
  // The changelog claims "everything under ~/.unsnooze". This is that claim,
  // and the writer list is derived from the code (every mkdir/write under
  // STATE_DIR), not from what happened to be convenient to call.
  const d = mkdtempSync(join(tmpdir(), 'unsnooze-allmodes-'));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(d)};
    const { join } = await import('node:path');
    const R = (m) => import(${JSON.stringify(pathToFileURL(join(ROOT, 'src')).href)} + '/' + m);
    const { updateState } = await R('state.js');
    const { writeHosts, writeFleetCache } = await R('fleet.js');
    const { setConfigValue } = await R('settings.js');
    const { writeUsageStore } = await R('usage.js');
    const { writeLease } = await R('lease.js');
    const { recordOwnedSession } = await R('mux-sessions.js');
    const { writeCache } = await R('update-check.js');
    const { acquireSingleton } = await R('resumer.js');
    const { makeLogger } = await R('logger.js');
    const { ensureAskpassHelper } = await R('askpass.js');
    updateState(s => s);                                    // state.json
    writeHosts({ box: 'box' });                             // hosts.json
    writeFleetCache([]);                                    // fleet-cache.json
    setConfigValue('ntfyTopic', 'unsnooze-x');              // config.json
    writeUsageStore({ v: 1 });                              // usage.json
    writeLease({ leaseId: 'L1', mux: 'tmux', pane: '%1', paneOwner: null, pid: 1 });
    recordOwnedSession({ mux: 'tmux', name: 'unsnooze' });  // mux-sessions/
    writeCache({ checkedAt: Date.now() });                  // update-check.json
    acquireSingleton({ isResumer: () => false });           // resumer.lock
    makeLogger('test')('hello');                            // unsnooze.log
    ensureAskpassHelper({ stateDir: ${JSON.stringify(d)}, scriptPath: '/x' });
    console.log('done');
  `], { encoding: 'utf8' });
  assert.equal(out.trim(), 'done');
  assert.deepEqual(tooOpenUnder(d), [], 'nothing the state dir holds may be group- or world-readable');
  rmSync(d, { recursive: true, force: true });
});

test('an upgraded 1.16.3 state dir is repaired, subdirectories included',
  { skip: !posix }, () => {
    // The writers alone cannot do this: mkdir's mode is ignored for a
    // directory that already exists, and an append reuses the file's inode.
    // 25 lease files and a headless log full of agent output are the real
    // shape of this on an upgraded machine.
    const d = mkdtempSync(join(tmpdir(), 'unsnooze-upgrade-'));
    for (const sub of ['events', 'leases', 'mux-sessions', 'headless']) {
      mkdirSync(join(d, sub));
      writeFileSync(join(d, sub, 'old.json'), '{}');
      chmodSync(join(d, sub, 'old.json'), 0o644);
      chmodSync(join(d, sub), 0o755);
    }
    for (const f of ['config.json', 'update-check.json', 'daemon.log']) {
      writeFileSync(join(d, f), '{}');
      chmodSync(join(d, f), 0o644);
    }
    chmodSync(d, 0o755);
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(d)};
      const { updateState } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/state.js')).href)});
      updateState(s => s);   // any single state write repairs the whole dir
      console.log('done');
    `], { encoding: 'utf8' });
    assert.equal(out.trim(), 'done');
    assert.deepEqual(tooOpenUnder(d), [], 'the repair must reach subdirectories and their contents');
    rmSync(d, { recursive: true, force: true });
  });

test('the mode repair never chmods through a symlink', { skip: !posix }, () => {
  // Guard on new behaviour: the old code had no repair to misbehave, so this
  // passes pre-fix. Mutation-checked instead — dropping the symlink skip
  // fails it.
  // chmod follows links, so a state file symlinked elsewhere would otherwise
  // have its TARGET's mode changed — a write reaching outside the state dir.
  const d = mkdtempSync(join(tmpdir(), 'unsnooze-symrepair-'));
  const outside = join(d, 'outside.json');
  writeFileSync(outside, '{"not":"ours"}');
  chmodSync(outside, 0o644);
  const state = join(d, 'state');
  mkdirSync(state);
  symlinkSync(outside, join(state, 'config.json'));
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(state)};
    const { updateState } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/state.js')).href)});
    updateState(s => s);
  `], { stdio: 'pipe' });
  assert.equal(mode(outside), 0o644, "the symlink's target must be left alone");
  rmSync(d, { recursive: true, force: true });
});

test('ensureStateDir does not narrow a directory that is not the state dir',
  { skip: !posix }, async () => {
    // Guard on new behaviour, vacuous against pre-fix code (no narrowing
    // existed). Mutation-checked: forcing isStateDir true fails it.
    // writeUsageStore is exported and takes any path; it must not chmod a
    // caller's project directory or the unrelated files inside it.
    const d = mkdtempSync(join(tmpdir(), 'unsnooze-foreign-'));
    writeFileSync(join(d, 'config.json'), '{"someone":"else"}');
    chmodSync(join(d, 'config.json'), 0o644);
    chmodSync(d, 0o755);
    const { writeUsageStore } = await import('../src/usage.js');
    writeUsageStore({ v: 1 }, join(d, 'usage.json'));
    assert.equal(mode(join(d, 'config.json')), 0o644, "an unrelated file must not be touched");
    assert.equal(mode(d), 0o755, "a caller's own directory must not be narrowed");
    rmSync(d, { recursive: true, force: true });
  });

test('transcriptPath refuses a session id that is not a safe filename', async () => {
  // Same class as the statusline shim, on the always-on hook channel:
  // sessionId arrives in a hook payload and is used as a path component.
  const { transcriptPath } = await import('../src/sessions.js');
  const claudeDir = '/claude';
  assert.equal(transcriptPath('/tmp/proj', '../../../../tmp/pwned', { claudeDir }), null);
  assert.equal(transcriptPath('/tmp/proj', '/etc/hosts', { claudeDir }), null);
  assert.equal(transcriptPath('/tmp/proj', 'a/b', { claudeDir }), null);
  assert.equal(transcriptPath('/tmp/proj', null, { claudeDir }), null);
  // ...while every id shape a real session actually uses still resolves.
  for (const id of ['abc-123', 'ab12cd34-5678-90ef-ab12-cd3456789012']) {
    assert.equal(transcriptPath('/tmp/proj', id, { claudeDir }),
      join(claudeDir, 'projects', '-tmp-proj', `${id}.jsonl`));
  }
});

test('doctor reports and repairs a state dir other users can read', { skip: !posix }, async () => {
  // ensureStateDir swallows a failed chmod (crashing every state write on a
  // filesystem without one would be worse), so something has to be able to
  // say it did not take. doctor is that something.
  const { findExposedStateFiles, narrowStateModes } = await import('../src/doctor.js');
  const d = mkdtempSync(join(tmpdir(), 'unsnooze-doctor-'));
  mkdirSync(join(d, 'leases'));
  writeFileSync(join(d, 'leases', 'a.json'), '{}');
  writeFileSync(join(d, 'state.json'), '{}');
  chmodSync(join(d, 'leases', 'a.json'), 0o644);
  chmodSync(join(d, 'state.json'), 0o644);
  chmodSync(join(d, 'leases'), 0o755);
  chmodSync(d, 0o755);

  const found = findExposedStateFiles(d);
  assert.deepEqual(found.map(f => f.rel).sort(), ['.', 'leases', 'leases/a.json', 'state.json']);
  assert.deepEqual(narrowStateModes(found), { fixed: 4, refused: 0, ineffective: 0 });
  assert.deepEqual(findExposedStateFiles(d), [], '--fix leaves nothing exposed');
  rmSync(d, { recursive: true, force: true });
});

test('doctor never chmods through a symlink either', { skip: !posix }, async () => {
  // Guard on new behaviour; doctor's check did not exist pre-fix.
  const { findExposedStateFiles, narrowStateModes } = await import('../src/doctor.js');
  const d = mkdtempSync(join(tmpdir(), 'unsnooze-doctorsym-'));
  const outside = join(d, 'outside.json');
  writeFileSync(outside, '{}');
  chmodSync(outside, 0o644);
  const state = join(d, 'state');
  mkdirSync(state, { mode: 0o700 });
  symlinkSync(outside, join(state, 'state.json'));
  narrowStateModes(findExposedStateFiles(state));
  assert.equal(mode(outside), 0o644, 'the link target keeps its own mode');
  rmSync(d, { recursive: true, force: true });
});

test('the workspace fingerprint is computed outside the state lock', { skip: !posix }, () => {
  // workspaceFingerprint shells out to git, and execFileSync's timeout only
  // signals the child — a git wedged on a hung mount never returns. Holding
  // the lock across that is what let a critical section outlive
  // HARD_STALE_LOCK_MS and be stolen from a writer still working.
  //
  // Deterministic rather than timing-based: a stub `git` on PATH records
  // whether the lock directory existed at the moment it ran.
  const d = mkdtempSync(join(tmpdir(), 'unsnooze-hoist-'));
  const bin = join(d, 'bin');
  mkdirSync(bin);
  const marker = join(d, 'saw-lock');
  writeFileSync(join(bin, 'git'),
    `#!/bin/sh\n[ -d "${join(d, 'state', 'state.lock')}" ] && echo held >> "${marker}" || echo free >> "${marker}"\nexit 1\n`,
    { mode: 0o755 });
  mkdirSync(join(d, 'state'));

  execFileSync(process.execPath, ['--input-type=module', '-e', `
    process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(join(d, 'state'))};
    const { upsertSession } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/state.js')).href)});
    upsertSession({
      sessionId: 'hoist-1', cwd: ${JSON.stringify(d)}, pane: '%1', mux: 'tmux',
      paneOwner: null, status: 'stopped', detectedAt: Date.now(),
    });
  `], { stdio: 'pipe', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

  const observations = readFileSync(marker, 'utf-8').trim().split('\n');
  assert.ok(observations.length > 0, 'the stub git must actually have run');
  assert.deepEqual([...new Set(observations)], ['free'],
    `git ran while the state lock was held: ${observations.join(',')}`);
  rmSync(d, { recursive: true, force: true });
});

test('a merged duplicate keeps the ORIGINAL workspace baseline', () => {
  // The hoist must not become the naive version: assigning the fingerprint to
  // `record` before the branch would let the merge's {...existing, ...record}
  // spread it over the baseline captured when the session first stopped.
  const base = { cwd: '/tmp/proj', pane: '%9', mux: 'tmux', paneOwner: null, status: 'stopped' };
  const detectedAt = Date.now();
  upsertSession({ ...base, sessionId: 'dup-1', detectedAt, workspace: { head: 'ORIGINAL', dirtyHash: 'a' } });
  assert.equal(readState().sessions['dup-1'].workspace.head, 'ORIGINAL');

  // a second detection of the same session, carrying no baseline of its own
  upsertSession({ ...base, sessionId: 'dup-1', detectedAt: detectedAt + 10 });
  assert.equal(readState().sessions['dup-1'].workspace.head, 'ORIGINAL',
    'the merge path must not overwrite the baseline captured at stop time');
});

test('the mode repair fires even when the state dir carries a trailing slash', { skip: !posix }, () => {
  // ensureStateDir compares the caller's directory against STATE_DIR to decide
  // whether the directory is ours to repair. Callers reach it through
  // dirname(join(STATE_DIR, 'config.json')), which normalizes a trailing slash
  // away — so a raw string comparison answers "not ours" and skips silently.
  const d = mkdtempSync(join(tmpdir(), 'unsnooze-slash-'));
  mkdirSync(join(d, 'leases'));
  writeFileSync(join(d, 'leases', 'o.json'), '{}');
  chmodSync(join(d, 'leases', 'o.json'), 0o644);
  chmodSync(join(d, 'leases'), 0o755);
  chmodSync(d, 0o755);
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(d + '/')};
    const { setConfigValue } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/settings.js')).href)});
    setConfigValue('ntfyTopic', 'unsnooze-x');   // writeConfig only — no state write
  `], { stdio: 'pipe' });
  assert.deepEqual(tooOpenUnder(d), [], 'a config-only run must still repair the directory');
  rmSync(d, { recursive: true, force: true });
});

test('a file that appears after the first repair pass is still narrowed', { skip: !posix }, () => {
  // daemon.log is created by launchd/systemd redirecting the daemon's stdout,
  // so it can show up at 0644 AFTER a repair has already run — and the daemon
  // then lives for days. A once-per-process repair would never revisit it.
  const d = mkdtempSync(join(tmpdir(), 'unsnooze-late-'));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(d)};
    const { updateState } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/state.js')).href)});
    const { writeFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const daemonLog = join(${JSON.stringify(d)}, 'daemon.log');
    updateState(s => s);                          // first repair pass
    writeFileSync(daemonLog, 'as launchd would'); // arrives afterwards, 0644
    const at = (statSync(daemonLog).mode & 0o777).toString(8);
    await new Promise(r => setTimeout(r, 20));
    updateState(s => s);                          // a later write re-checks
    console.log(JSON.stringify({ at, after: (statSync(daemonLog).mode & 0o777).toString(8) }));
  `], { encoding: 'utf8', env: { ...process.env, UNSNOOZE_MODE_REPAIR_MS: '1' } });
  const r = JSON.parse(out.trim());
  assert.equal(r.at, '644', 'precondition: nothing of ours created it');
  assert.equal(r.after, '600', 'a later state write must narrow it');
  rmSync(d, { recursive: true, force: true });
});

test('the mode repair strips group and other without destroying the execute bit',
  { skip: !posix }, () => {
    // The state dir holds executables — askpass.sh, and whatever else lands
    // beside it. A flat 0600 turns those into EACCES the next time something
    // spawns them, which is a far louder bug than the one being fixed.
    const d = mkdtempSync(join(tmpdir(), 'unsnooze-execbit-'));
    writeFileSync(join(d, 'runnable.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(d, 'runnable.sh'), 0o755);
    writeFileSync(join(d, 'plain.json'), '{}');
    chmodSync(join(d, 'plain.json'), 0o644);
    chmodSync(d, 0o755);
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(d)};
      const { updateState } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/state.js')).href)});
      updateState(s => s);
    `], { stdio: 'pipe' });
    assert.equal(mode(join(d, 'runnable.sh')), 0o700, 'owner keeps +x, group/other lose everything');
    assert.equal(mode(join(d, 'plain.json')), 0o600);
    assert.deepEqual(tooOpenUnder(d), []);
    assert.equal(execFileSync(join(d, 'runnable.sh'), { encoding: 'utf8' }).trim(), 'hi',
      'and it is still executable afterwards');
    rmSync(d, { recursive: true, force: true });
  });

test('doctor sees a state dir that is itself a symlink', { skip: !posix }, async () => {
  // The scan stats the root rather than lstat'ing it: a dotfiles-managed or
  // other-volume state dir is a real setup, and refusing to look through the
  // link turned the whole check off — zero findings while the repair, which
  // does follow it, was busy fixing things.
  const { findExposedStateFiles } = await import('../src/doctor.js');
  const d = mkdtempSync(join(tmpdir(), 'unsnooze-symroot-'));
  const real = join(d, 'real-state');
  mkdirSync(real);
  writeFileSync(join(real, 'config.json'), '{}');
  chmodSync(join(real, 'config.json'), 0o644);
  chmodSync(real, 0o755);
  const link = join(d, 'linked-state');
  symlinkSync(real, link);
  const found = findExposedStateFiles(link);
  assert.deepEqual(found.map(f => f.rel).sort(), ['.', 'config.json'],
    'a symlinked state dir must still be inspected, not silently skipped');
  rmSync(d, { recursive: true, force: true });
});

test('the repair fixes leftovers the old allowlist never named', { skip: !posix }, () => {
  // A quarantined state.json and a crashed writer's tmp file hold verbatim
  // copies of the state. A fixed list of filenames missed both, so they
  // stayed world-readable AND doctor reported them forever without the
  // automatic repair ever clearing the finding.
  const d = mkdtempSync(join(tmpdir(), 'unsnooze-leftovers-'));
  for (const f of ['state.json.corrupt.1750000000000', '.state.tmp.4242', 'hosts.json.tmp.4242']) {
    writeFileSync(join(d, f), '{"secret":"copy of state"}');
    chmodSync(join(d, f), 0o644);
  }
  chmodSync(d, 0o755);
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(d)};
    const { updateState } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/state.js')).href)});
    updateState(s => s);
  `], { stdio: 'pipe' });
  assert.deepEqual(tooOpenUnder(d), [], 'leftovers are narrowed like anything else');
});

test('the permission check is inert on Windows, where the mode bits are synthetic',
  { skip: !posix }, async () => {
    // libuv mirrors the owner bits into group and other on Windows, so every
    // entry reads as 0666/0777 and `mode & 0o077` is never zero — while
    // chmod there only toggles the read-only attribute. Without this gate
    // doctor could never report healthy, `--fix` would claim repairs it did
    // not make, and the daemon would re-chmod the whole directory forever.
    // (Run from POSIX by injecting the platform; there is no Windows host.)
    const { scanStateDir } = await import('../src/config.js');
    const d = mkdtempSync(join(tmpdir(), 'unsnooze-win-'));
    writeFileSync(join(d, 'config.json'), '{}');
    chmodSync(join(d, 'config.json'), 0o644);
    chmodSync(d, 0o755);

    assert.ok(scanStateDir(d, { platform: 'linux' }).length > 0,
      'precondition: on POSIX this directory is genuinely exposed');
    assert.deepEqual(scanStateDir(d, { platform: 'win32' }), [],
      'on Windows the same directory must produce no findings at all');
    rmSync(d, { recursive: true, force: true });
  });

test('a hardlinked entry is reported but never chmodded through', { skip: !posix }, async () => {
  // lstat cannot tell a hardlink from an ordinary file, so chmodding one
  // would change an inode that also lives outside the state dir. Skipping the
  // REPAIR is right; skipping the REPORT would hide a genuinely exposed file
  // from the very check whose job is to surface what the repair cannot fix.
  const { scanStateDir } = await import('../src/config.js');
  const d = mkdtempSync(join(tmpdir(), 'unsnooze-hardlink-'));
  const outside = join(d, 'outside.txt');
  writeFileSync(outside, 'not ours');
  chmodSync(outside, 0o644);
  const state = join(d, 'state');
  mkdirSync(state, { mode: 0o700 });
  linkSync(outside, join(state, 'linked.json'));

  const found = scanStateDir(state);
  assert.deepEqual(found.map(e => e.rel), ['linked.json'], 'reported…');
  assert.equal(found[0].skipRepair, true, '…but flagged as not repairable');

  execFileSync(process.execPath, ['--input-type=module', '-e', `
    process.env.UNSNOOZE_STATE_DIR = ${JSON.stringify(state)};
    const { updateState } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src/state.js')).href)});
    updateState(s => s);
  `], { stdio: 'pipe' });
  assert.equal(mode(outside), 0o644, 'the shared inode keeps its own mode');
  rmSync(d, { recursive: true, force: true });
});

test('the repair count separates changed, refused and silently ignored',
  { skip: !posix }, async () => {
    // "chmod did not throw" is not "the mode changed", and the difference is
    // what made --fix claim success on a filesystem with no POSIX modes.
    // Exercising only the working path does NOT discriminate — both the honest
    // and the naive implementation agree there. The discriminating case is
    // chmod succeeding while the bits stay put, which is reachable portably by
    // handing narrowStateDir an entry whose `want` is its current mode.
    const { scanStateDir, narrowStateDir } = await import('../src/config.js');
    const d = mkdtempSync(join(tmpdir(), 'unsnooze-count-'));
    writeFileSync(join(d, 'a.json'), '{}');
    chmodSync(join(d, 'a.json'), 0o644);
    chmodSync(d, 0o755);

    const found = scanStateDir(d);
    assert.equal(found.length, 2, 'the dir and the file');
    assert.deepEqual(narrowStateDir(found), { fixed: 2, refused: 0, ineffective: 0 });
    assert.deepEqual(narrowStateDir(scanStateDir(d)), { fixed: 0, refused: 0, ineffective: 0 },
      'nothing left to change');

    // chmod succeeds, bits do not move: must count as ignored, never as fixed.
    const stuck = join(d, 'a.json');
    chmodSync(stuck, 0o644);
    assert.deepEqual(
      narrowStateDir([{ path: stuck, rel: 'a.json', mode: 0o644, want: 0o644 }]),
      { fixed: 0, refused: 0, ineffective: 1 },
      'a no-op chmod is reported as ignored by the filesystem, not as a repair',
    );
    rmSync(d, { recursive: true, force: true });
  });

test('a filesystem that ignores chmod is not walked forever', { skip: !posix }, async () => {
  // The convergence half of the same problem: without this, a state dir on a
  // CIFS/vfat mount (or WSL drvfs) is re-chmodded in full every interval for
  // the life of the daemon, never getting anywhere.
  const { scanStateDir, narrowStateDir } = await import('../src/config.js');
  const d = mkdtempSync(join(tmpdir(), 'unsnooze-noop-'));
  writeFileSync(join(d, 'a.json'), '{}');
  chmodSync(join(d, 'a.json'), 0o644);
  // Simulate the no-op filesystem by asking for a mode that is already set.
  const entries = scanStateDir(d).map(e => ({ ...e, want: e.mode }));
  const r = narrowStateDir(entries);
  assert.equal(r.fixed, 0);
  assert.equal(r.refused, 0);
  assert.ok(r.ineffective > 0, 'the ignored case is what repairModes keys its give-up on');
  rmSync(d, { recursive: true, force: true });
});

// F5: this test's title and lead comment described the old non-JSON fixture.

test('the permission check keys off the real filesystem, not a simulated platform',
  { skip: !posix }, async () => {
    // runDoctor's `platform` simulates an install target. Whether chmod means
    // anything is a property of the host filesystem, so this check must not
    // read the simulated value — doing so raised the finding on a Windows
    // runner for a test that had injected 'darwin', where no repair could
    // ever clear it. scanStateDir's own platform option stays injectable.
    const { runDoctor } = await import('../src/doctor.js');
    const d = mkdtempSync(join(tmpdir(), 'unsnooze-windoctor-'));
    writeFileSync(join(d, 'config.json'), '{}');
    chmodSync(join(d, 'config.json'), 0o644);
    chmodSync(d, 0o755);

    const common = {
      runner: () => ({ status: 1, stdout: '' }),
      csgBinPath: null,
      mux: { available: () => true, name: 'headless' },
      designRegistered: () => false,
      hookInstalled: () => true,
      wrappersInstalled: () => true,
      stateDir: d,
    };
    for (const platform of ['linux', 'win32', 'darwin']) {
      const report = await runDoctor({ ...common, platform });
      assert.ok(report.findings.some(f => f.id === 'state-permissions'),
        `simulating ${platform} must not change what this POSIX filesystem reports`);
    }
    rmSync(d, { recursive: true, force: true });
  });
