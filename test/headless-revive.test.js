// End-to-end headless revive: the real resumer, the real headless backend, a
// real spawned process. The unit tests cover each half; this proves the seam
// between them, which is where a pane-less revive would actually break —
// capturePane() returning '' has to route the dispatch through reopen(), and
// reopen() has to hand the prompt over in argv because there is nothing to
// type into.

import { test as baseTest, after } from 'node:test';

// Spawns a POSIX shim as the "agent". The behaviour under test is
// platform-independent and covered on Windows by test/headless.test.js.
const test = process.platform === 'win32'
  ? (name, fn) => baseTest(name, { skip: 'unix-only harness (sh agent shim)' }, fn)
  : baseTest;
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-headless-revive-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');
process.env.UNSNOOZE_VERIFY_DELAY_MS = '0';

const { dispatchOne, verifyOne } = await import('../src/resumer.js');
const { upsertSession, readState } = await import('../src/state.js');
const { createHeadless } = await import('../src/multiplexers/headless.js');
const { RESUME_SESSION_NAME } = await import('../src/config.js');

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

// A stand-in for `node bin/unsnooze.js _run claude …`: records the argv it was
// launched with so we can assert what a real revive would have run.
const RECORD = join(DIR, 'argv.txt');
const SHIM = join(DIR, 'fake-agent.sh');
writeFileSync(SHIM, `#!/bin/sh\nprintf '%s\\n' "$@" > "${RECORD}"\necho "agent started"\n`);
chmodSync(SHIM, 0o755);

function seed(overrides = {}) {
  const rec = {
    sessionId: '00000000-0000-4000-8000-000000000042',
    cwd: DIR, pane: null, mux: 'headless', paneOwner: null,
    muxSession: 'unsnooze-headless', agent: 'claude',
    status: 'stopped', limitType: '5h', detectedVia: 'hook',
    detectedAt: Date.now() - 3_600_000, resetAt: Date.now() - 1000,
    resetSource: 'absolute', attempts: 0,
    ...overrides,
  };
  const state = upsertSession(rec);
  return Object.values(state.sessions).find(s => s.sessionId === rec.sessionId);
}

// A detached child writes on its own schedule, and under a loaded full-suite
// run the file can exist before its last line does: wait for content that
// ends in a newline, not for the path.
async function waitForWritten(path, { timeoutMs = 10_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf-8');
      if (text.endsWith('\n')) return text;
    }
    await new Promise(r => setTimeout(r, 25));
  }
  return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

async function waitForOutcome(mux, pane, { timeoutMs = 10_000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const o = await mux.paneOutcome(pane);
    if (o?.exited) return o;
    await new Promise(r => setTimeout(r, 25));
  }
  return mux.paneOutcome(pane);
}

test('a headless revive spawns a real process and carries the prompt in argv', async () => {
  const rec = seed();
  const mux = createHeadless({ logDir: join(DIR, 'logs'), env: {} });

  const result = await dispatchOne(rec, {
    mux,
    resolveMux: () => mux,
    selfCmd: [SHIM],   // stands in for [node, bin/unsnooze.js]
  });

  assert.equal(result, 'reopen', 'no pane to type into means the reopen path');

  const written = await waitForWritten(RECORD);
  assert.ok(written, 'the revive must actually start a process');

  const argv = written.trim().split('\n');
  assert.deepEqual(argv.slice(0, 3), ['_run', 'claude', '--resume'],
    `revive argv was ${JSON.stringify(argv)}`);
  assert.equal(argv[3], '00000000-0000-4000-8000-000000000042');
  assert.ok(argv[4] && argv[4].length > 0,
    'the resume prompt must ride in argv — headless can never type it');
});

test('the revive output is captured where a user can actually read it', async () => {
  const logDir = join(DIR, 'logs');
  assert.ok(existsSync(logDir), 'headless must create its log dir');
  // Named for the session the revive actually landed in, not the record's
  // muxSession: headless deliberately has no sessionExists(), so reviveTarget()
  // cannot confirm the old session and falls through to RESUME_SESSION_NAME.
  const log = join(logDir, `${RESUME_SESSION_NAME}.log`);
  for (let i = 0; i < 40 && !existsSync(log); i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(existsSync(log), `expected a log at ${log}`);
  assert.match(readFileSync(log, 'utf-8'), /agent started/,
    'with no pane to scroll back through, the log is the only record');
});

// #25: every headless Codex revival used to run the TUI form, which exits 1
// before touching the session ("stdin is not a terminal"). The seam that has
// to hold is backendCanType(headless) → codex.resumeArgs(canType: false) →
// argv, through the real resumer.
test('a headless codex revive runs `exec resume`, not the TUI', async () => {
  const record = join(DIR, 'argv-codex.txt');
  const shim = join(DIR, 'fake-codex-launcher.sh');
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\n`);
  chmodSync(shim, 0o755);
  const rec = seed({ agent: 'codex', sessionId: '019f56fe-3508-7f10-8bb2-5e1db403916f', detectedVia: 'transcript' });
  const mux = createHeadless({ logDir: join(DIR, 'logs'), env: {} });

  const result = await dispatchOne(rec, { mux, resolveMux: () => mux, selfCmd: [shim] });
  assert.equal(result, 'reopen');
  const written = await waitForWritten(record);
  assert.ok(written, 'the revive must actually start a process');
  const argv = written.trim().split('\n');
  assert.deepEqual(argv.slice(0, 5), ['_run', 'codex', 'exec', 'resume', '019f56fe-3508-7f10-8bb2-5e1db403916f'],
    `revive argv was ${JSON.stringify(argv)}`);
  assert.ok(argv[5] && argv[5].length > 0, 'the wake prompt rides in argv');
});

// #25: the launcher died with `spawn codex ENOENT` (exit 127) and verifyOne
// read the empty headless capture as a cleared banner — "verified resumed"
// for a process that lived a few hundred milliseconds. The exit is recorded
// now, and a non-zero one puts the stop back on the ledger with the reason.
test('a headless revive that dies non-zero goes back to stopped with the child\'s own words', async () => {
  const shim = join(DIR, 'dying-launcher.sh');
  writeFileSync(shim, '#!/bin/sh\necho "unsnooze: failed to launch codex: spawn codex ENOENT" >&2\nexit 127\n');
  chmodSync(shim, 0o755);
  const rec = seed({ agent: 'codex', sessionId: '019f56fe-0000-4000-8000-00000000dead', detectedVia: 'transcript' });
  const mux = createHeadless({ logDir: join(DIR, 'logs'), env: {} });

  assert.equal(await dispatchOne(rec, { mux, resolveMux: () => mux, selfCmd: [shim] }), 'reopen');
  let cur = readState().sessions[rec.key];
  assert.equal(cur.status, 'resuming');
  const outcome = await waitForOutcome(mux, cur.pane);
  assert.equal(outcome?.exited, true, `outcome was ${JSON.stringify(outcome)}`);
  assert.equal(outcome.code, 127);
  assert.match(outcome.output, /spawn codex ENOENT/);

  assert.equal(await verifyOne(rec.key, { resolveMux: () => mux }), 'retry');
  cur = readState().sessions[rec.key];
  assert.equal(cur.status, 'stopped', 'a dead launcher is not a resumed session');
  assert.equal(cur.attempts, 1);
  assert.ok(cur.resetAt > Date.now(), 'retried with backoff, not immediately');
  assert.match(cur.lastError, /exit 127/);
  assert.match(cur.lastError, /spawn codex ENOENT/, 'the reason must reach `unsnooze status`');
});

test('a headless revive that ran to completion (exit 0) still verifies as resumed', async () => {
  const shim = join(DIR, 'finishing-launcher.sh');
  writeFileSync(shim, '#!/bin/sh\necho "continuing the task"\nexit 0\n');
  chmodSync(shim, 0o755);
  const rec = seed({ sessionId: '00000000-0000-4000-8000-0000000000ok' });
  const mux = createHeadless({ logDir: join(DIR, 'logs'), env: {} });

  assert.equal(await dispatchOne(rec, { mux, resolveMux: () => mux, selfCmd: [shim] }), 'reopen');
  const cur = readState().sessions[rec.key];
  assert.equal((await waitForOutcome(mux, cur.pane))?.code, 0);
  assert.equal(await verifyOne(rec.key, { resolveMux: () => mux }), 'resumed');
  assert.equal(readState().sessions[rec.key].status, 'resumed');
});
