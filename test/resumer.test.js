// dispatchOne / verifyOne decision logic with fake tmux.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-resumer-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';   // no desktop popups from tests
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');
process.env.UNSNOOZE_READY_TIMEOUT_MS = '6000';   // keep the reopen poll short in tests
process.env.UNSNOOZE_VERIFY_DELAY_MS = '0';

const {
  dispatchOne, verifyOne, routeDispatchOutcome, runResumer, probeFallback,
  reviveTarget, awaitReadyAndSend, planFor,
} = await import('../src/resumer.js');
const {
  upsertSession, readState, setStatus, updateState, activeStopped,
  sweepRecords, markStaleAbandoned,
} = await import('../src/state.js');
const { RESUME_SESSION_NAME, LOG_FILE } = await import('../src/config.js');
const { getAgent } = await import('../src/agents/index.js');
const { transcriptPath } = await import('../src/sessions.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

function seed(overrides = {}) {
  const rec = {
    sessionId: overrides.sessionId ?? `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
    cwd: '/tmp/proj', pane: '%1', mux: 'tmux', paneOwner: null, muxSession: 'unsnooze-test',
    status: 'stopped', limitType: '5h', detectedVia: 'hook',
    detectedAt: Date.now() - 3_600_000, resetAt: Date.now() - 1000,
    resetSource: 'absolute', attempts: 0, lastAttemptAt: null, lastError: null,
    ...overrides,
  };
  const state = upsertSession(rec);
  return Object.values(state.sessions).find(s => s.sessionId === rec.sessionId)
    ?? Object.values(state.sessions).find(s => s.pane === rec.pane);
}

test('pane-less record with env → reopened with structured environment', async () => {
  const rec = seed({ pane: null, agent: 'codex', env: { CLAUDE_CONFIG_DIR: '/tmp/sandbox/.claude' } });
  const windows = [];
  const tmux = {
    paneAlive: async () => false,
    newWindow: async (session, cwd, command) => { windows.push({ session, cwd, command }); return { pane: '%77', paneOwner: null }; },
  };
  const result = await dispatchOne(rec, { mux: tmux });
  assert.equal(result, 'reopen');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].command.env.CLAUDE_CONFIG_DIR, '/tmp/sandbox/.claude');
});

test('reopen environment contains only record env and unsnooze control vars', async () => {
  process.env.SECRET_API_KEY = 'must-not-leak';
  process.env.UNRELATED_DAEMON_SETTING = 'must-not-leak-either';
  try {
    const rec = seed({
      pane: null,
      agent: 'codex',
      env: {
        CLAUDE_CONFIG_DIR: '/tmp/sandbox/.claude',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
      },
    });
    let launchSpec;
    const mux = {
      newWindow: async (_session, _cwd, spec) => {
        launchSpec = spec;
        return { pane: '%177', paneOwner: null };
      },
    };

    assert.equal(await dispatchOne(rec, { mux }), 'reopen');
    assert.deepEqual(launchSpec.env, {
      CLAUDE_CONFIG_DIR: '/tmp/sandbox/.claude',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
      UNSNOOZE_MUX: 'tmux',
      UNSNOOZE_LEASE_ID: launchSpec.env.UNSNOOZE_LEASE_ID,
    });
  } finally {
    delete process.env.SECRET_API_KEY;
    delete process.env.UNRELATED_DAEMON_SETTING;
  }
});

test('herdr reopen environment carries the target session as pane owner', async () => {
  const rec = seed({ mux: 'herdr', pane: null, agent: 'codex', muxSession: 'revive-herdr', paneOwner: 'old-herdr' });
  let launchSpec;
  const mux = {
    sessionExists: async name => name === 'revive-herdr',
    newWindow: async (_session, _cwd, spec) => {
      launchSpec = spec;
      return { pane: 'w1:p1', paneOwner: 'revive-herdr' };
    },
  };
  assert.equal(await dispatchOne(rec, { mux }), 'reopen');
  assert.equal(launchSpec.env.UNSNOOZE_MUX, 'herdr');
  assert.equal(launchSpec.env.UNSNOOZE_PANE_OWNER, 'revive-herdr');
});

test('record with cwd null → reopened in the home dir, not a newWindow crash', async () => {
  const rec = seed({ pane: null, agent: 'codex', cwd: null });
  const windows = [];
  const tmux = {
    paneAlive: async () => false,
    newWindow: async (session, cwd, command) => { windows.push({ session, cwd, command }); return { pane: '%78', paneOwner: null }; },
  };
  const result = await dispatchOne(rec, { mux: tmux });
  assert.equal(result, 'reopen');
  assert.equal(typeof windows[0].cwd, 'string');
  assert.ok(windows[0].cwd.length > 0, 'cwd must be a real path — execFile rejects null args');
});

test('live idle claude pane → message sent', async () => {
  const rec = seed({ pane: '%10' });
  const sent = [];
  const tmux = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'node',
    capturePane: async () => '❯ \n',
    sendText: async (pane, text) => sent.push({ pane, text }),
  };
  const result = await dispatchOne(rec, { mux: tmux });
  assert.equal(result, 'injected');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].pane, '%10');
  assert.equal(readState().sessions[rec.key].status, 'resuming');
});

test('live but busy pane → deferred, nothing sent', async () => {
  const rec = seed({ pane: '%11' });
  const sent = [];
  const tmux = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '✻ Thinking… (esc to interrupt)',
    sendText: async (...a) => sent.push(a),
  };
  assert.equal(await dispatchOne(rec, { mux: tmux }), 'busy');
  assert.equal(sent.length, 0);
});

test('successful parent turn after the stop prevents a duplicate wake', async () => {
  const detectedAt = Date.now() - 10_000;
  const rec = seed({
    pane: '%112', agent: 'claude', cwd: '/tmp/proj-post-limit-progress',
    sessionId: '00000000-0000-4000-8000-000000000112',
    detectedAt, bannerAt: detectedAt,
  });
  const path = transcriptPath(rec.cwd, rec.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    type: 'assistant',
    timestamp: new Date(detectedAt + 1000).toISOString(),
    message: { role: 'assistant', usage: { input_tokens: 2, output_tokens: 1 } },
  }) + '\n');
  const sent = [];
  const mux = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '❯ ',
    sendText: async (...args) => sent.push(args),
  };

  assert.equal(await dispatchOne(rec, { mux }), 'already-resumed');
  assert.equal(sent.length, 0);
  assert.equal(readState().sessions[rec.key].status, 'resumed');
});

test('successful parent turn in an isolated Claude config prevents a duplicate wake', async () => {
  const detectedAt = Date.now() - 10_000;
  const claudeDir = join(DIR, 'isolated-claude-progress');
  const rec = seed({
    pane: '%113', agent: 'claude', cwd: '/tmp/proj-isolated-progress',
    sessionId: '00000000-0000-4000-8000-000000000113',
    detectedAt, bannerAt: detectedAt, env: { CLAUDE_CONFIG_DIR: claudeDir },
  });
  const path = transcriptPath(rec.cwd, rec.sessionId, { claudeDir });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    type: 'assistant', timestamp: new Date(detectedAt + 1000).toISOString(),
    message: { role: 'assistant', usage: { input_tokens: 2, output_tokens: 1 } },
  }) + '\n');
  let sent = 0;
  const mux = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '❯ ',
    sendText: async () => { sent += 1; },
  };

  assert.equal(await dispatchOne(rec, { mux }), 'already-resumed');
  assert.equal(sent, 0);
});

test('progress appearing during pane assessment is rechecked before send', async () => {
  const detectedAt = Date.now() - 10_000;
  const rec = seed({
    pane: '%114', agent: 'claude', cwd: '/tmp/proj-late-progress',
    sessionId: '00000000-0000-4000-8000-000000000114',
    detectedAt, bannerAt: detectedAt,
  });
  const path = transcriptPath(rec.cwd, rec.sessionId);
  let wrote = false;
  let sent = 0;
  const mux = {
    paneAlive: async () => {
      if (!wrote) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({
          type: 'assistant', timestamp: new Date(detectedAt + 1000).toISOString(),
          message: { role: 'assistant', usage: { input_tokens: 2, output_tokens: 1 } },
        }) + '\n');
        wrote = true;
      }
      return true;
    },
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '❯ ',
    sendText: async () => { sent += 1; },
  };

  assert.equal(await dispatchOne(rec, { mux }), 'already-resumed');
  assert.equal(sent, 0);
  assert.equal(readState().sessions[rec.key].status, 'resumed');
});

test('a refreshed stop episode makes a stale dispatch relinquish without sending', async () => {
  const detectedAt = Date.now() - 10_000;
  const rec = seed({ pane: '%115', agent: 'claude', detectedAt, bannerAt: detectedAt });
  let sent = 0;
  const mux = {
    paneAlive: async () => {
      updateState(state => {
        state.sessions[rec.key].bannerAt = detectedAt + 5_000;
        return state;
      });
      return true;
    },
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '❯ ',
    sendText: async () => { sent += 1; },
  };

  assert.equal(await dispatchOne(rec, { mux }), 'stale');
  assert.equal(sent, 0);
  assert.equal(readState().sessions[rec.key].status, 'stopped');
});

test('alive foreground agent with unrecognized content defers instead of reopening', async () => {
  const rec = seed({ pane: '%111' });
  let opened = false;
  const mux = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '',
    newWindow: async () => {
      opened = true;
      throw new Error('must not reopen an owned live pane');
    },
  };

  assert.equal(await dispatchOne(rec, { mux, matchesLease: async () => false }), 'busy');
  assert.equal(opened, false);
});

test('dead pane → reopened via new tmux window with --resume <id>', async () => {
  const rec = seed({ pane: '%12', sessionId: '11111111-2222-4333-8444-555555555555' });
  const sent = [];
  let windowCmd = null;
  const tmux = {
    paneAlive: async () => false,
    paneCurrentCommand: async () => null,
    capturePane: async () => '❯ \n',        // new pane immediately ready
    sendText: async (pane, text) => sent.push({ pane, text }),
    newWindow: async (session, cwd, command) => { windowCmd = { session, cwd, command }; return { pane: '%99', paneOwner: null }; },
  };
  const result = await dispatchOne(rec, { mux: tmux });
  assert.equal(result, 'reopen');
  assert.ok(windowCmd.command.args.includes('11111111-2222-4333-8444-555555555555'));
  assert.equal(windowCmd.cwd, '/tmp/proj');
  assert.equal(sent[0].pane, '%99');
  assert.equal(readState().sessions[rec.key].pane, '%99');
});

test('pane alive but running a shell → reopen path (never hijack a shell)', async () => {
  const rec = seed({ pane: '%13', sessionId: '22222222-3333-4444-8555-666666666666' });
  let opened = false;
  const tmux = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'zsh',
    capturePane: async () => '❯ \n',
    sendText: async () => {},
    newWindow: async () => { opened = true; return { pane: '%98', paneOwner: null }; },
  };
  assert.equal(await dispatchOne(rec, { mux: tmux }), 'reopen');
  assert.equal(opened, true);
});

test('dead codex pane → reopened via `_run codex resume <id> "msg"`, nothing typed', async () => {
  const rec = seed({ pane: '%20', agent: 'codex', sessionId: '33333333-4444-4555-8666-777777777777' });
  const sent = [];
  let windowCmd = null;
  const tmux = {
    paneAlive: async () => false,
    paneCurrentCommand: async () => null,
    capturePane: async () => '› Ask Codex to do anything\n',
    sendText: async (pane, text) => sent.push({ pane, text }),
    newWindow: async (session, cwd, command) => { windowCmd = { session, cwd, command }; return { pane: '%97', paneOwner: null }; },
  };
  const result = await dispatchOne(rec, { mux: tmux, resumeMessage: "it's time to continue" });
  assert.equal(result, 'reopen');
  assert.deepEqual(windowCmd.command.args.slice(-4),
    ['codex', 'resume', '33333333-4444-4555-8666-777777777777', "it's time to continue"]);
  assert.equal(sent.length, 0);                                     // message travels in argv
});

test('per-agent message: UNSNOOZE_RESUME_MESSAGE_CLAUDE overrides the global for a live claude pane', async () => {
  process.env.UNSNOOZE_RESUME_MESSAGE_CLAUDE = 'claude, wake up';
  try {
    const rec = seed({ pane: '%23' });
    const sent = [];
    const tmux = {
      paneAlive: async () => true,
      paneCurrentCommand: async () => 'claude',
      capturePane: async () => '❯ \n',
      sendText: async (pane, text) => sent.push({ pane, text }),
    };
    assert.equal(await dispatchOne(rec, { mux: tmux }), 'injected');
    assert.equal(sent[0].text, 'claude, wake up');
  } finally {
    delete process.env.UNSNOOZE_RESUME_MESSAGE_CLAUDE;
  }
});

test('per-agent message: UNSNOOZE_RESUME_MESSAGE_CODEX lands in the codex resume argv', async () => {
  process.env.UNSNOOZE_RESUME_MESSAGE_CODEX = 'codex custom wake';
  try {
    const rec = seed({ pane: '%24', agent: 'codex', sessionId: '44444444-5555-4666-8777-888888888888' });
    const sent = [];
    let windowCmd = null;
    const tmux = {
      paneAlive: async () => false,
      paneCurrentCommand: async () => null,
      capturePane: async () => '› Ask Codex to do anything\n',
      sendText: async (pane, text) => sent.push({ pane, text }),
      newWindow: async (session, cwd, command) => { windowCmd = { session, cwd, command }; return { pane: '%94', paneOwner: null }; },
    };
    assert.equal(await dispatchOne(rec, { mux: tmux }), 'reopen');
    assert.equal(windowCmd.command.args.at(-1), 'codex custom wake');
    assert.equal(sent.length, 0);
  } finally {
    delete process.env.UNSNOOZE_RESUME_MESSAGE_CODEX;
  }
});

test('explicit resumeMessage option beats the per-agent env override', async () => {
  process.env.UNSNOOZE_RESUME_MESSAGE_CLAUDE = 'from env';
  try {
    const rec = seed({ pane: '%25' });
    const sent = [];
    const tmux = {
      paneAlive: async () => true,
      paneCurrentCommand: async () => 'claude',
      capturePane: async () => '❯ \n',
      sendText: async (pane, text) => sent.push({ pane, text }),
    };
    assert.equal(await dispatchOne(rec, { mux: tmux, resumeMessage: 'explicit wins' }), 'injected');
    assert.equal(sent[0].text, 'explicit wins');
  } finally {
    delete process.env.UNSNOOZE_RESUME_MESSAGE_CLAUDE;
  }
});

test('reopen command embeds absolute node + entry-point paths (tmux server PATH is not ours)', async () => {
  // Regression: `unsnooze _run ...` resolved through the tmux SERVER's PATH,
  // which may lack npm globals or nvm's node entirely — reopen then fails
  // with command-not-found (or runs some other unsnooze).
  const rec = seed({ pane: '%21', sessionId: '55555555-6666-4777-8888-999999999999' });
  let windowCmd = null;
  const tmux = {
    paneAlive: async () => false,
    paneCurrentCommand: async () => null,
    capturePane: async () => '❯ \n',
    sendText: async () => {},
    newWindow: async (session, cwd, command) => { windowCmd = command; return { pane: '%96', paneOwner: null }; },
  };
  await dispatchOne(rec, { mux: tmux });
  assert.equal(windowCmd.file, process.execPath);
  assert.match(windowCmd.args[0], /bin[/\\]unsnooze\.js$/);
  assert.deepEqual(windowCmd.args.slice(1, 3), ['_run', 'claude']);
});

test('UNSNOOZE_SELF overrides the reopen binary (test harness escape hatch)', async () => {
  process.env.UNSNOOZE_SELF = '/fake/bin/unsnooze';
  try {
    const rec = seed({ pane: '%22', sessionId: '66666666-7777-4888-8999-aaaaaaaaaaaa' });
    let windowCmd = null;
    const tmux = {
      paneAlive: async () => false,
      paneCurrentCommand: async () => null,
      capturePane: async () => '❯ \n',
      sendText: async () => {},
      newWindow: async (session, cwd, command) => { windowCmd = command; return { pane: '%95', paneOwner: null }; },
    };
    await dispatchOne(rec, { mux: tmux });
    assert.equal(windowCmd.file, '/fake/bin/unsnooze');
    assert.deepEqual(windowCmd.args.slice(0, 2), ['_run', 'claude']);
  } finally {
    delete process.env.UNSNOOZE_SELF;
  }
});

test('per-session resumeMessage beats the global default (live-pane path)', async () => {
  const rec = seed({ pane: '%30', resumeMessage: 'finish the tests then commit' });
  const sent = [];
  const tmux = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '❯ \n',
    sendText: async (pane, text) => sent.push(text),
  };
  await dispatchOne(rec, { mux: tmux });
  assert.deepEqual(sent, ['finish the tests then commit']);
});

test('per-session resumeMessage reaches the codex argv path', async () => {
  const rec = seed({ pane: '%31', agent: 'codex', resumeMessage: 'deploy checklist next' });
  let windowCmd = null;
  const tmux = {
    paneAlive: async () => false,
    paneCurrentCommand: async () => null,
    capturePane: async () => '› \n',
    sendText: async () => {},
    newWindow: async (session, cwd, command) => { windowCmd = command; return { pane: '%94', paneOwner: null }; },
  };
  await dispatchOne(rec, { mux: tmux });
  assert.equal(windowCmd.args.at(-1), 'deploy checklist next');
  assert.ok(!windowCmd.args.includes('Continue where you left off'));
});

test('without a per-session message the global default still applies', async () => {
  const rec = seed({ pane: '%32' });
  const sent = [];
  const tmux = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '❯ \n',
    sendText: async (pane, text) => sent.push(text),
  };
  await dispatchOne(rec, { mux: tmux });
  assert.match(sent[0], /^Continue where you left off/);
});

test('verifyOne: banner back → rescheduled as stopped with attempts+1', async () => {
  const rec = seed({ pane: '%14' });
  const tmuxSend = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '❯ \n',
    sendText: async () => {},
  };
  await dispatchOne(rec, { mux: tmuxSend });     // → resuming
  const tmuxVerify = {
    capturePane: async () => "⚠ You've hit your 5-hour limit\n· resets 9pm (UTC)\n> ",
  };
  await verifyOne(rec.key, { resolveMux: () => tmuxVerify });
  const after1 = readState().sessions[rec.key];
  assert.equal(after1.status, 'stopped');
  assert.equal(after1.attempts, 1);
  assert.ok(after1.resetAt > Date.now());
});

test('verifyOne: clean pane → resumed', async () => {
  const rec = seed({ pane: '%15' });
  const tmuxSend = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '❯ \n',
    sendText: async () => {},
  };
  await dispatchOne(rec, { mux: tmuxSend });
  await verifyOne(rec.key, { resolveMux: () => ({ capturePane: async () => '⏺ continuing the task…\n' }) });
  const resumed = readState().sessions[rec.key];
  assert.equal(resumed.status, 'resumed');
  assert.equal(resumed.bannerCleared, true);

  const freshAt = rec.detectedAt + 5_000;
  upsertSession({
    ...rec, status: 'stopped', detectedAt: freshAt, bannerAt: freshAt,
    resetAt: Date.now() + 60_000, attempts: 0,
  });
  assert.equal(readState().sessions[rec.key].status, 'stopped',
    'a later limit must re-arm after verified clean progress');
});

test('verifyOne: a newer stop merged before verification is not erased', async () => {
  const rec = seed({ pane: '%215' });
  await dispatchOne(rec, { mux: {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '❯ ',
    sendText: async () => {},
  } });
  const freshAt = rec.detectedAt + 5_000;
  upsertSession({
    ...rec, status: 'stopped', detectedAt: freshAt, bannerAt: freshAt,
    resetAt: Date.now() + 60_000, attempts: 0,
  });
  assert.equal(readState().sessions[rec.key].status, 'resuming',
    'ingest preserves the in-flight status until verification');

  assert.equal(await verifyOne(rec.key, {
    resolveMux: () => ({ capturePane: async () => 'working normally' }),
  }), 'stale');
  const saved = readState().sessions[rec.key];
  assert.equal(saved.status, 'stopped');
  assert.equal(saved.bannerAt, freshAt);
});

test('verifyOne: a stop arriving during capture wins over a clean snapshot', async () => {
  const rec = seed({ pane: '%216' });
  await dispatchOne(rec, { mux: {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '❯ ',
    sendText: async () => {},
  } });
  const freshAt = rec.detectedAt + 5_000;
  assert.equal(await verifyOne(rec.key, {
    resolveMux: () => ({
      capturePane: async () => {
        upsertSession({
          ...rec, status: 'stopped', detectedAt: freshAt, bannerAt: freshAt,
          resetAt: Date.now() + 60_000, attempts: 0,
        });
        return 'working normally';
      },
    }),
  }), 'stale');
  const saved = readState().sessions[rec.key];
  assert.equal(saved.status, 'stopped');
  assert.equal(saved.bannerAt, freshAt);
});

test('verifyOne: pane-less resuming record returns to stopped after three persisted retries', async () => {
  const rec = seed({ pane: null, attempts: 1, lastError: 'reopen interrupted' });
  setStatus(rec.key, 'resuming');

  assert.equal(await verifyOne(rec.key), 'retry');
  assert.equal(readState().sessions[rec.key].verifyRetries, 1);
  assert.equal(await verifyOne(rec.key), 'retry');
  assert.equal(readState().sessions[rec.key].verifyRetries, 2);
  assert.equal(await verifyOne(rec.key), 'retry');

  const saved = readState().sessions[rec.key];
  assert.equal(saved.status, 'stopped');
  assert.equal(saved.attempts, 2);
  assert.equal(saved.verifyRetries, 0);
  assert.equal(saved.lastError, 'verify: pane unavailable');
});

test('verifyOne: successful verification resets the persisted retry counter', async () => {
  const rec = seed({ pane: '%115' });
  setStatus(rec.key, 'resuming', { verifyRetries: 2, lastError: 'verify capture: transient' });

  assert.equal(await verifyOne(rec.key, {
    resolveMux: () => ({ capturePane: async () => 'working normally' }),
  }), 'resumed');

  const saved = readState().sessions[rec.key];
  assert.equal(saved.status, 'resumed');
  assert.equal(saved.verifyRetries, 0);
  assert.equal(saved.lastError, null);
});

const WS_BEFORE = { head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', dirtyHash: 'd1' };
const WS_AFTER  = { head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', dirtyHash: 'd1' };

function liveTmux(sent) {
  return {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '\u276f \n',
    sendText: async (pane, text) => sent.push(text),
  };
}

test('workspaceGuard inform (default): changed repo → wake message carries the heads-up', async () => {
  const rec = seed({ pane: '%33', workspace: WS_BEFORE });
  const sent = [];
  await dispatchOne(rec, { mux: liveTmux(sent), fingerprint: () => WS_AFTER });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /workspace changed while the session was stopped/i);
  assert.match(sent[0], /aaaaaaa → bbbbbbb/);
});

test('workspaceGuard inform: unchanged repo → clean message', async () => {
  const rec = seed({ pane: '%34', workspace: WS_BEFORE });
  const sent = [];
  await dispatchOne(rec, { mux: liveTmux(sent), fingerprint: () => ({ ...WS_BEFORE }) });
  assert.ok(!/workspace changed/i.test(sent[0]));
});

test('workspaceGuard pause: changed repo → held, nothing sent, notified once', async () => {
  process.env.UNSNOOZE_WORKSPACE_GUARD = 'pause';
  try {
    const rec = seed({ pane: '%35', workspace: WS_BEFORE });
    const sent = [];
    const toasts = [];
    const result = await dispatchOne(rec, {
      mux: liveTmux(sent), fingerprint: () => WS_AFTER,
      notifier: (t, m, opts) => toasts.push({ t, m, opts }),
    });
    assert.equal(result, 'held');
    assert.equal(sent.length, 0);
    const after1 = readState().sessions[rec.key];
    assert.equal(after1.workspaceHold, true);
    assert.match(after1.holdReason, /HEAD/);
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].t, /session held/);
    assert.deepEqual(toasts[0].opts?.context, { mux: 'tmux', pane: '%35', paneOwner: null });
    const { dueForDispatch } = await import('../src/resumer.js');
    assert.ok(!dueForDispatch().some(s => s.key === rec.key), 'held records are not dispatchable');
    // resume-now marks manual → bypasses the guard entirely
    const again = await dispatchOne({ ...readState().sessions[rec.key], manual: true }, {
      mux: liveTmux(sent), fingerprint: () => WS_AFTER, notifier: () => {},
    });
    assert.equal(again, 'injected');
  } finally {
    delete process.env.UNSNOOZE_WORKSPACE_GUARD;
  }
});

test('workspaceGuard off: changed repo ignored', async () => {
  process.env.UNSNOOZE_WORKSPACE_GUARD = 'off';
  try {
    const rec = seed({ pane: '%36', workspace: WS_BEFORE });
    const sent = [];
    await dispatchOne(rec, { mux: liveTmux(sent), fingerprint: () => WS_AFTER });
    assert.equal(sent.length, 1);
    assert.ok(!/workspace changed/i.test(sent[0]));
  } finally {
    delete process.env.UNSNOOZE_WORKSPACE_GUARD;
  }
});

test('contextGuard pause: big context → held, nothing sent, notified once', async () => {
  process.env.UNSNOOZE_CONTEXT_GUARD = 'pause';
  try {
    const rec = seed({ pane: '%81' });
    const sent = [];
    const toasts = [];
    const result = await dispatchOne(rec, {
      mux: liveTmux(sent), contextTokens: () => 152_500,
      notifier: (t, m, opts) => toasts.push({ t, m, opts }),
    });
    assert.equal(result, 'held');
    assert.equal(sent.length, 0);
    const after1 = readState().sessions[rec.key];
    assert.equal(after1.workspaceHold, true);
    assert.match(after1.holdReason, /context ~153k tokens/);
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].t, /session held/);
    assert.match(toasts[0].m, /~153k tokens/);
    assert.deepEqual(toasts[0].opts?.context, { mux: 'tmux', pane: '%81', paneOwner: null });
    const { dueForDispatch } = await import('../src/resumer.js');
    assert.ok(!dueForDispatch().some(s => s.key === rec.key), 'held records are not dispatchable');
    // resume-now marks manual → bypasses the guard entirely
    const again = await dispatchOne({ ...readState().sessions[rec.key], manual: true }, {
      mux: liveTmux(sent), contextTokens: () => 152_500, notifier: () => {},
    });
    assert.equal(again, 'injected');
  } finally {
    delete process.env.UNSNOOZE_CONTEXT_GUARD;
  }
});

test('contextGuard pause: below threshold → resumes normally, no toast', async () => {
  process.env.UNSNOOZE_CONTEXT_GUARD = 'pause';
  try {
    const rec = seed({ pane: '%82' });
    const sent = [];
    const toasts = [];
    const result = await dispatchOne(rec, {
      mux: liveTmux(sent), contextTokens: () => 50_000,
      notifier: (t, m, opts) => toasts.push({ t, m, opts }),
    });
    assert.equal(result, 'injected');
    assert.equal(sent.length, 1);
    assert.equal(toasts.length, 0);
  } finally {
    delete process.env.UNSNOOZE_CONTEXT_GUARD;
  }
});

test('contextGuard inform (default): big context → resumed, clean wake message, one toast', async () => {
  const rec = seed({ pane: '%83' });
  const sent = [];
  const toasts = [];
  const result = await dispatchOne(rec, {
    mux: liveTmux(sent), contextTokens: () => 152_500,
    notifier: (t, m, opts) => toasts.push({ t, m, opts }),
  });
  assert.equal(result, 'injected');
  assert.equal(sent.length, 1);
  assert.ok(!/context/i.test(sent[0]), 'wake message must not mention context size');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].t, /big-context wake/);
  assert.match(toasts[0].m, /~153k-token/);
  assert.deepEqual(toasts[0].opts?.context, { mux: 'tmux', pane: '%83', paneOwner: null });
});

test('contextGuard inform: busy pane → no toast (notify only on delivery)', async () => {
  const rec = seed({ pane: '%84' });
  const toasts = [];
  const busyTmux = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'claude',
    capturePane: async () => '✻ Cogitating… (esc to interrupt)',
    sendText: async () => { throw new Error('must not send while busy'); },
  };
  const result = await dispatchOne(rec, {
    mux: busyTmux, contextTokens: () => 152_500,
    notifier: (t, m, opts) => toasts.push({ t, m, opts }),
  });
  assert.equal(result, 'busy');
  assert.equal(toasts.length, 0);
});

test('contextGuard inform: reopen path → toast fires after the message lands', async () => {
  const sid = '00000000-0000-4000-8000-c0417e871111';   // fixed id: seed() finds pane-null records unreliably
  seed({ sessionId: sid, pane: null });
  const rec = readState().sessions[sid];
  const sent = [];
  const toasts = [];
  const mux = {
    newWindow: async () => ({ pane: '%85', paneOwner: null }),
    capturePane: async () => '❯ \n',
    sendText: async (pane, text) => sent.push(text),
  };
  const result = await dispatchOne(rec, {
    mux, resolveMux: () => mux, contextTokens: () => 152_500,
    notifier: (t, m, opts) => toasts.push({ t, m, opts }),
  });
  assert.equal(result, 'reopen');
  assert.equal(sent.length, 1);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].t, /big-context wake/);
});

test('contextGuard inform: below threshold → no toast', async () => {
  const rec = seed({ pane: '%86' });
  const toasts = [];
  await dispatchOne(rec, {
    mux: liveTmux([]), contextTokens: () => 50_000,
    notifier: (t, m, opts) => toasts.push({ t, m, opts }),
  });
  assert.equal(toasts.length, 0);
});

test('contextGuard: threshold honors the env override', async () => {
  process.env.UNSNOOZE_CONTEXT_GUARD_TOKENS = '200000';
  try {
    const rec = seed({ pane: '%87' });
    const toasts = [];
    const result = await dispatchOne(rec, {
      mux: liveTmux([]), contextTokens: () => 152_500,
      notifier: (t, m, opts) => toasts.push({ t, m, opts }),
    });
    assert.equal(result, 'injected');
    assert.equal(toasts.length, 0);
  } finally {
    delete process.env.UNSNOOZE_CONTEXT_GUARD_TOKENS;
  }
});

test('contextGuard off and manual resumes: estimator never called', async () => {
  process.env.UNSNOOZE_CONTEXT_GUARD = 'off';
  let calls = 0;
  try {
    const rec = seed({ pane: '%88' });
    const result = await dispatchOne(rec, {
      mux: liveTmux([]), contextTokens: () => { calls++; return 152_500; },
    });
    assert.equal(result, 'injected');
  } finally {
    delete process.env.UNSNOOZE_CONTEXT_GUARD;
  }
  const rec2 = seed({ pane: '%89', manual: true });
  const result2 = await dispatchOne(rec2, {
    mux: liveTmux([]), contextTokens: () => { calls++; return 152_500; },
  });
  assert.equal(result2, 'injected');
  assert.equal(calls, 0);
});

test('contextGuard: estimator null or throwing → resumes silently', async () => {
  const toasts = [];
  const rec = seed({ pane: '%90' });
  assert.equal(await dispatchOne(rec, {
    mux: liveTmux([]), contextTokens: () => null,
    notifier: (t, m, opts) => toasts.push({ t, m, opts }),
  }), 'injected');
  const rec2 = seed({ pane: '%91' });
  assert.equal(await dispatchOne(rec2, {
    mux: liveTmux([]), contextTokens: () => { throw new Error('transcript unreadable'); },
    notifier: (t, m, opts) => toasts.push({ t, m, opts }),
  }), 'injected');
  assert.equal(toasts.length, 0);
});

test('contextGuard: adapter without contextTokens → guard skipped, no crash', async () => {
  const sid = '00000000-0000-4000-8000-c0417e872222';   // fixed id: seed() finds pane-null records unreliably
  seed({ sessionId: sid, pane: null, agent: 'codex' });
  const rec = readState().sessions[sid];
  const toasts = [];
  const mux = { newWindow: async () => ({ pane: '%92', paneOwner: null }) };
  const result = await dispatchOne(rec, {
    mux, resolveMux: () => mux,
    notifier: (t, m, opts) => toasts.push({ t, m, opts }),
  });
  assert.equal(result, 'reopen');
  assert.equal(toasts.length, 0);
});

const MENU = [
  'What do you want to do?',
  '❯ 1. Upgrade your plan',
  '  2. Stop and wait for limit to reset',
  '(enter to confirm)',
].join('\n');

test('ordered injection: capture failure retries before any command or injection', async () => {
  const rec = seed({ pane: '%40' });
  let commandLookups = 0;
  const result = await dispatchOne(rec, { mux: {
    paneAlive: async () => true,
    capturePane: async () => { throw new Error('dump failed'); },
    paneCurrentCommand: async () => { commandLookups++; return 'claude'; },
  } });
  assert.equal(result, 'retry');
  assert.equal(commandLookups, 0);
});

test('ordered injection: successful menu drive makes progress without consuming an attempt', async () => {
  const rec = seed({ pane: '%41' });
  const sent = [];
  const result = await dispatchOne(rec, {
    mux: {
      paneAlive: async () => true, capturePane: async () => MENU,
      paneCurrentCommand: async () => 'claude',
      sendKey: async (_pane, key) => sent.push(key),
      newWindow: async () => { throw new Error('must not reopen'); },
    },
    matchesLease: async () => false,
  });
  assert.equal(result, 'progress');
  assert.deepEqual(sent, ['Down', 'Enter']);
  routeDispatchOutcome(result, rec, new Map());
  const saved = readState().sessions[rec.key];
  assert.equal(saved.status, 'stopped');
  assert.equal(saved.attempts, 0);
});

test('ordered injection: refreshed stop episode blocks stale menu keystrokes', async () => {
  const detectedAt = Date.now() - 10_000;
  const rec = seed({ pane: '%141', agent: 'claude', detectedAt, bannerAt: detectedAt });
  const sent = [];
  const result = await dispatchOne(rec, {
    mux: {
      paneAlive: async () => {
        updateState(state => {
          state.sessions[rec.key].bannerAt = detectedAt + 5_000;
          return state;
        });
        return true;
      },
      capturePane: async () => MENU,
      paneCurrentCommand: async () => 'claude',
      sendKey: async (_pane, key) => sent.push(key),
    },
    matchesLease: async () => false,
  });
  assert.equal(result, 'stale');
  assert.deepEqual(sent, []);
  assert.equal(readState().sessions[rec.key].status, 'stopped');
});

test('ordered injection: authorized menu with toggle off is held', async () => {
  process.env.UNSNOOZE_MENU_AUTO_ANSWER = 'off';
  try {
    const rec = seed({ pane: '%42' });
    const result = await dispatchOne(rec, {
      mux: {
        paneAlive: async () => true, capturePane: async () => MENU,
        paneCurrentCommand: async () => 'claude',
      }, matchesLease: async () => true,
    });
    assert.equal(result, 'held');
  } finally { delete process.env.UNSNOOZE_MENU_AUTO_ANSWER; }
});

test('ordered injection: unauthorized menu reopens instead of driving keys', async () => {
  const rec = seed({ pane: '%142' });
  const sent = [];
  let opened = false;
  const mux = {
    paneAlive: async () => true,
    capturePane: async () => MENU,
    paneCurrentCommand: async () => 'zsh',
    sendKey: async (_pane, key) => sent.push(key),
    newWindow: async () => { opened = true; return { pane: '%242', paneOwner: null }; },
  };
  assert.equal(await dispatchOne(rec, { mux, matchesLease: async () => false }), 'reopen');
  assert.equal(opened, true);
  assert.deepEqual(sent, []);
});

test('ordered injection: banner and leased idle panes inject; unauthorized idle reopens', async () => {
  const injected = [];
  const banner = seed({ pane: '%43' });
  const bannerMux = {
    paneAlive: async () => true,
    capturePane: async () => "⚠ You've hit your 5-hour limit\n· resets 9pm (UTC)\n> ",
    paneCurrentCommand: async () => 'claude',
    sendText: async pane => injected.push(pane),
  };
  assert.equal(await dispatchOne(banner, { mux: bannerMux, matchesLease: async () => false }), 'injected');

  const leased = seed({ pane: '%44' });
  const leasedMux = { ...bannerMux, capturePane: async () => '❯ ', paneCurrentCommand: async () => 'zsh' };
  assert.equal(await dispatchOne(leased, { mux: leasedMux, matchesLease: async () => true }), 'injected');

  const unsafe = seed({ pane: '%45', agent: 'codex' });
  let opened = false;
  const unsafeMux = {
    paneAlive: async () => true, capturePane: async () => '› ',
    paneCurrentCommand: async () => 'zsh',
    newWindow: async () => { opened = true; return { pane: '%145', paneOwner: null }; },
  };
  assert.equal(await dispatchOne(unsafe, { mux: unsafeMux, matchesLease: async () => false }), 'reopen');
  assert.equal(opened, true);
});

test('reopen rebinds owner, publishes lease id in structured env, and scrubs stale pane context', async () => {
  process.env.UNSNOOZE_PANE = 'stale';
  process.env.UNSNOOZE_PANE_OWNER = 'stale-owner';
  try {
    const rec = seed({ mux: 'zellij', paneOwner: 'main', pane: '3', muxSession: 'revive' });
    let launchSpec;
    const oldMux = {
      paneAlive: async () => false,
      // Live named session → join it (do not fall back to unsnooze-resumed).
      sessionExists: async name => name === 'revive',
      newWindow: async (session, _cwd, spec) => {
        assert.equal(session, 'revive');
        launchSpec = spec;
        return { pane: '9', paneOwner: session };
      },
    };
    const sent = [];
    const resolved = [];
    const newMux = {
      capturePane: async pane => { assert.equal(pane, '9'); return '❯ '; },
      sendText: async pane => sent.push(pane),
    };
    const result = await dispatchOne(rec, {
      mux: oldMux,
      resolveMux: next => { resolved.push(next.paneOwner); return newMux; },
    });
    assert.equal(result, 'reopen');
    assert.deepEqual(resolved, ['revive']);
    assert.deepEqual(sent, ['9']);
    assert.equal(launchSpec.env.UNSNOOZE_PANE, undefined);
    assert.equal(launchSpec.env.UNSNOOZE_ACTIVE, undefined);
    assert.equal(launchSpec.env.UNSNOOZE_PANE_OWNER, 'revive');
    const saved = readState().sessions[rec.key];
    assert.equal(saved.paneOwner, 'revive');
    assert.equal(saved.leaseId, launchSpec.env.UNSNOOZE_LEASE_ID);
  } finally {
    delete process.env.UNSNOOZE_PANE;
    delete process.env.UNSNOOZE_PANE_OWNER;
  }
});

test('verifyOne capture failure stays resuming and re-resolves the re-read record', async () => {
  const rec = seed({ pane: '%46' });
  setStatus(rec.key, 'resuming');
  const result = await verifyOne(rec.key, {
    resolveMux: current => {
      assert.equal(current.key, rec.key);
      return { capturePane: async () => { throw new Error('transient'); } };
    },
  });
  assert.equal(result, 'retry');
  const saved = readState().sessions[rec.key];
  assert.equal(saved.status, 'resuming');
  assert.match(saved.lastError, /transient/);
});

test('runResumer resolves the record for dispatch and re-resolves it for verification', async () => {
  updateState(state => { state.sessions = {}; });
  const rec = seed({ pane: '%146', agent: 'codex' });
  let captures = 0;
  const fakeMux = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'codex',
    capturePane: async () => (++captures === 1 ? '› ' : 'working normally'),
    sendText: async () => {},
  };
  const resolved = [];
  const code = await runResumer({
    resolveMux: current => { resolved.push(current.key); return fakeMux; },
    pollInterval: 1,
  });
  assert.equal(code, 0);
  assert.ok(resolved.length >= 2, 'dispatch and verify must each resolve from their record');
  assert.ok(resolved.every(key => key === rec.key));
  assert.equal(readState().sessions[rec.key].status, 'resumed');
});

test('two session ids on one active pane dispatch once even outside ingest dedupe', async () => {
  updateState(state => { state.sessions = {}; });
  const detectedAt = Date.now() - 140_000;
  upsertSession({
    sessionId: '00000000-0000-4000-8000-000000000161',
    cwd: '/tmp/proj-one-pane', pane: '%161', mux: 'tmux', paneOwner: null,
    agent: 'claude', status: 'stopped', limitType: '5h', detectedVia: 'hook',
    detectedAt, resetAt: Date.now() - 1000, resetSource: 'absolute', attempts: 0,
  });
  upsertSession({
    sessionId: '00000000-0000-4000-8000-000000000162',
    cwd: '/tmp/proj-one-pane', pane: '%161', mux: 'tmux', paneOwner: null,
    agent: 'claude', status: 'stopped', limitType: '5h', detectedVia: 'scrape',
    detectedAt: detectedAt + 130_000, resetAt: Date.now() - 1000,
    resetSource: 'absolute', attempts: 0,
  });
  assert.equal(activeStopped().length, 2, 'fixture must exceed the 120-second ingest window');

  let sent = 0;
  const mux = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'node',
    capturePane: async () => (sent === 0 ? '❯ ' : 'working normally'),
    sendText: async () => { sent += 1; },
  };
  const before = activeStopped().sort((a, b) => a.detectedAt - b.detectedAt);
  const plans = await Promise.all(before.map(rec => planFor(rec, {
    mux, matchesLease: async () => false,
  })));
  assert.deepEqual(plans.map(plan => plan.action), ['none', 'inject'],
    'preview must show the same one-owner decision as dispatch');
  assert.equal(await runResumer({ resolveMux: () => mux, pollInterval: 1 }), 0);
  assert.equal(sent, 1);
  const records = Object.values(readState().sessions);
  assert.equal(records.filter(rec => rec.status === 'resumed').length, 1);
  assert.equal(records.filter(rec => rec.status === 'cancelled').length, 1);
  assert.match(records.find(rec => rec.status === 'cancelled').lastError, /superseded/);
});

test('active-target election never crosses pane lease generations', async () => {
  updateState(state => { state.sessions = {}; });
  const oldAt = Date.now() - 140_000;
  const currentState = upsertSession({
    sessionId: '00000000-0000-4000-8000-000000000171',
    cwd: '/tmp/proj-lease-generation', pane: '%171', mux: 'tmux', paneOwner: null,
    leaseId: 'current-lease', agent: 'claude', status: 'stopped', limitType: '5h',
    detectedVia: 'hook', detectedAt: oldAt, bannerAt: oldAt,
    resetAt: Date.now() - 1000, resetSource: 'absolute', attempts: 0,
  });
  const current = currentState.sessions['00000000-0000-4000-8000-000000000171'];
  upsertSession({
    sessionId: '00000000-0000-4000-8000-000000000172',
    cwd: '/tmp/proj-lease-generation', pane: '%171', mux: 'tmux', paneOwner: null,
    leaseId: 'stale-lease', agent: 'claude', status: 'stopped', limitType: '5h',
    detectedVia: 'hook', detectedAt: oldAt + 130_000, bannerAt: oldAt + 130_000,
    resetAt: Date.now() - 1000, resetSource: 'absolute', attempts: 0,
  });
  let sent = 0;
  const mux = {
    paneAlive: async () => true,
    paneOwnerStamp: async () => 'current-lease',
    paneCurrentCommand: async () => 'node',
    capturePane: async () => '❯ ',
    sendText: async () => { sent += 1; },
  };
  const result = await dispatchOne(current, {
    mux,
    matchesLease: async rec => rec.leaseId === 'current-lease',
  });
  assert.equal(result, 'injected');
  assert.equal(sent, 1);
  const saved = readState().sessions;
  assert.equal(saved[current.key].status, 'resuming');
  assert.equal(saved['00000000-0000-4000-8000-000000000172'].status, 'stopped');
});

test('defer outcome routing keeps busy, retry, and held semantically distinct', () => {
  const counts = new Map();
  const busy = seed({ pane: '%47' });
  const routedBusy = routeDispatchOutcome('busy', busy, counts, { maxBusyDefers: 0 });
  assert.equal(readState().sessions[busy.key].status, 'stopped');
  assert.equal(readState().sessions[busy.key].attempts, 0);
  assert.deepEqual(routedBusy, { verify: false, waitBusy: false });
  assert.equal(counts.get(busy.key), 1, 'the saturated counter keeps later busy polls delay-free');
  assert.deepEqual(routeDispatchOutcome('busy', busy, counts, { maxBusyDefers: 0 }),
    { verify: false, waitBusy: false });

  const retry = seed({ pane: '%48' });
  routeDispatchOutcome('retry', retry, counts);
  assert.equal(readState().sessions[retry.key].status, 'stopped');
  assert.equal(readState().sessions[retry.key].attempts, 1);

  const held = seed({ pane: '%49' });
  routeDispatchOutcome('held', held, counts);
  assert.equal(readState().sessions[held.key].status, 'stopped');
  assert.equal(readState().sessions[held.key].attempts, 0);
});

// --- §4 fallback probing ---

test('probeFallback: banner still present → reschedule next probe, not 5h', async () => {
  const now = Date.now();
  const rec = seed({
    pane: '%200',
    resetSource: 'fallback',
    resetAt: now - 1000,
    detectedAt: now - 60_000,
    probeCount: 0,
  });
  const mux = {
    paneAlive: async () => true,
    capturePane: async () => 'Rate limit exceeded. Please wait.\n> ',
  };
  // Use grok-like patterns via agent on record
  updateState(s => { s.sessions[rec.key].agent = 'grok'; });
  const refreshed = readState().sessions[rec.key];
  const result = await probeFallback(refreshed, { mux, now });
  assert.equal(result, 'probe');
  const after = readState().sessions[rec.key];
  assert.equal(after.resetSource, 'fallback');
  assert.equal(after.probeCount, 1);
  const wait = after.resetAt - now;
  // ~15 min + margin, not 5h
  assert.ok(wait < 20 * 60_000, `expected probe-scale wait, got ${wait}ms`);
  assert.ok(wait > 10 * 60_000, `expected ~15m wait, got ${wait}ms`);
});

test('probeFallback: banner gone → null (proceed to resume)', async () => {
  const rec = seed({
    pane: '%201',
    resetSource: 'fallback',
    resetAt: Date.now() - 1000,
    probeCount: 1,
  });
  const mux = {
    paneAlive: async () => true,
    capturePane: async () => '❯ working normally\n',
  };
  assert.equal(await probeFallback(rec, { mux }), null);
});

test('probeFallback: custom Claude config transcript upgrades the reset', async () => {
  const now = Date.now();
  const claudeDir = join(DIR, 'probe-custom-claude');
  const rec = seed({
    sessionId: '00000000-0000-4000-8000-000000000204',
    cwd: '/tmp/proj-custom-probe', pane: null, agent: 'claude',
    resetSource: 'fallback', resetAt: now - 1000, detectedAt: now - 60_000,
    probeCount: 0, env: { CLAUDE_CONFIG_DIR: claudeDir },
  });
  const path = transcriptPath(rec.cwd, rec.sessionId, { claudeDir });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    isSidechain: false, type: 'assistant', isApiErrorMessage: true,
    error: 'rate_limit', timestamp: new Date(now).toISOString(),
    sessionId: rec.sessionId, cwd: rec.cwd,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: "You've hit your session limit · resets in 2 hours" }],
    },
  }) + '\n');

  assert.equal(await probeFallback(rec, { mux: {}, now }), 'probe');
  const saved = readState().sessions[rec.key];
  assert.notEqual(saved.resetSource, 'fallback');
  assert.equal(saved.probeCount, 0);
});

test('dispatchOne on fallback with live banner returns probe (no inject)', async () => {
  const rec = seed({
    pane: '%202',
    agent: 'grok',
    resetSource: 'fallback',
    resetAt: Date.now() - 1000,
    probeCount: 0,
    detectedAt: Date.now() - 60_000,
  });
  let injected = false;
  const mux = {
    paneAlive: async () => true,
    paneCurrentCommand: async () => 'grok',
    capturePane: async () => 'Rate limit exceeded. Please wait a moment and try again.\n> ',
    sendText: async () => { injected = true; },
  };
  assert.equal(await dispatchOne(rec, { mux, matchesLease: async () => true }), 'probe');
  assert.equal(injected, false);
});

test('routeDispatchOutcome treats probe like held (no verify, no attempt bump)', () => {
  const rec = seed({ pane: '%203', resetSource: 'fallback' });
  const counts = new Map();
  const routed = routeDispatchOutcome('probe', rec, counts);
  assert.deepEqual(routed, { verify: false, waitBusy: false });
  assert.equal(readState().sessions[rec.key].attempts, 0);
});

// --- session-name ownership tests (merged from plan 1) ---

test('reopen environment contains only record env and unsnooze control vars', async () => {
  process.env.SECRET_API_KEY = 'must-not-leak';
  process.env.UNRELATED_DAEMON_SETTING = 'must-not-leak-either';
  try {
    const rec = seed({
      pane: null,
      agent: 'codex',
      env: {
        CLAUDE_CONFIG_DIR: '/tmp/sandbox/.claude',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
      },
    });
    let launchSpec;
    let targetSession;
    const mux = {
      sessionExists: async () => false,
      newWindow: async (session, _cwd, spec) => {
        targetSession = session;
        launchSpec = spec;
        return { pane: '%177', paneOwner: null };
      },
    };

    assert.equal(await dispatchOne(rec, { mux }), 'reopen');
    // tmux paneOwner is always null — do NOT set UNSNOOZE_PANE_OWNER from muxSession.
    assert.deepEqual(launchSpec.env, {
      CLAUDE_CONFIG_DIR: '/tmp/sandbox/.claude',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
      UNSNOOZE_MUX: 'tmux',
      UNSNOOZE_LEASE_ID: launchSpec.env.UNSNOOZE_LEASE_ID,
    });
    // Dead/absent original session → dedicated resume session, never the base name.
    assert.equal(targetSession, RESUME_SESSION_NAME);
    assert.equal(readState().sessions[rec.key].muxSession, RESUME_SESSION_NAME);
  } finally {
    delete process.env.SECRET_API_KEY;
    delete process.env.UNRELATED_DAEMON_SETTING;
  }
});

test('reviveTarget joins a live named session and otherwise uses RESUME_SESSION_NAME', async () => {
  const live = { sessionExists: async name => name === 'unsnooze' };
  assert.equal(await reviveTarget(live, { muxSession: 'unsnooze' }), 'unsnooze');
  assert.equal(await reviveTarget(live, { tmuxSession: 'unsnooze' }), 'unsnooze');

  const dead = { sessionExists: async () => false };
  assert.equal(await reviveTarget(dead, { muxSession: 'unsnooze' }), RESUME_SESSION_NAME);
  assert.equal(await reviveTarget(dead, { muxSession: null }), RESUME_SESSION_NAME);
  // Never invents the interactive base name when nothing is live.
  assert.notEqual(RESUME_SESSION_NAME, 'unsnooze');
  assert.ok(RESUME_SESSION_NAME.endsWith('-resumed'));
});

test('sweepRecords drops dead-pane terminal records but keeps live ones', async () => {
  const dead = seed({ sessionId: 'sweep-dead', pane: '%d1', status: 'resumed' });
  setStatus(dead.key, 'resumed');
  const live = seed({ sessionId: 'sweep-live', pane: '%l1', status: 'resumed' });
  setStatus(live.key, 'resumed');
  // Only %l1 is "alive"; every other terminal record (including leftovers from
  // earlier tests in this file) is treated as dead and swept.
  const n = await sweepRecords({
    resolveMux: () => ({ paneAlive: async pane => pane === '%l1' }),
  });
  assert.ok(n >= 1);
  const state = readState();
  assert.equal(state.sessions[dead.key], undefined);
  assert.ok(state.sessions[live.key]);
});

test('sweepRecords cannot delete a fresh stop that arrives during liveness check', async () => {
  updateState(state => { state.sessions = {}; });
  const rec = seed({
    sessionId: 'sweep-episode-race', pane: '%sweep-race', status: 'resumed',
    bannerCleared: true, detectedAt: Date.now() - 60_000,
  });
  const freshAt = Date.now();
  const removed = await sweepRecords({
    resolveMux: () => ({
      paneAlive: async () => {
        upsertSession({
          ...rec, status: 'stopped', detectedAt: freshAt, bannerAt: freshAt,
          resetAt: freshAt + 60_000, attempts: 0,
        });
        return false;
      },
    }),
  });
  assert.equal(removed, 0);
  const saved = readState().sessions[rec.key];
  assert.ok(saved);
  assert.equal(saved.status, 'stopped');
  assert.equal(saved.bannerAt, freshAt);
});

test('stale stopped record with a dead pane is marked failed instead of revived', async () => {
  const rec = seed({
    sessionId: 'stale-old',
    pane: '%gone',
    status: 'stopped',
    detectedAt: Date.now() - 8 * 86_400_000,
    resetAt: Date.now() - 1000,
  });
  const n = await markStaleAbandoned({
    resolveMux: () => ({ paneAlive: async () => false }),
    staleAfterMs: 7 * 86_400_000,
  });
  assert.equal(n, 1);
  assert.equal(readState().sessions[rec.key].status, 'failed');
  assert.match(readState().sessions[rec.key].lastError, /stale/);
});

test('markStaleAbandoned cannot fail a fresh stop that arrives during liveness check', async () => {
  updateState(state => { state.sessions = {}; });
  const oldAt = Date.now() - 8 * 86_400_000;
  const rec = seed({
    sessionId: 'stale-episode-race', pane: '%stale-race', status: 'stopped',
    detectedAt: oldAt, bannerAt: oldAt,
  });
  const freshAt = Date.now();
  const marked = await markStaleAbandoned({
    resolveMux: () => ({
      paneAlive: async () => {
        upsertSession({
          ...rec, status: 'stopped', detectedAt: freshAt, bannerAt: freshAt,
          resetAt: freshAt + 60_000, attempts: 0,
        });
        return false;
      },
    }),
    staleAfterMs: 7 * 86_400_000,
  });
  assert.equal(marked, 0);
  const saved = readState().sessions[rec.key];
  assert.equal(saved.status, 'stopped');
  assert.equal(saved.bannerAt, freshAt);
});

test('sweepRecords preserves failed records (post-mortem evidence) — prune owns their expiry', async () => {
  // Observed live: a record that gave up after 5 attempts was swept within
  // 30s, destroying its lastError before anyone could read `unsnooze status`.
  const failed = seed({ sessionId: 'sweep-keep-failed', pane: '%f1', status: 'stopped' });
  setStatus(failed.key, 'failed', { lastError: 'new-window: spawn tmux ENOENT' });
  await sweepRecords({ resolveMux: () => ({ paneAlive: async () => false }) });
  const rec = readState().sessions[failed.key];
  assert.ok(rec, 'failed record survives the sweep');
  assert.equal(rec.lastError, 'new-window: spawn tmux ENOENT');
});

test('reopen logs new-window failures instead of failing silently', async () => {
  const rec = seed({ sessionId: 'log-reopen-fail', pane: null, agent: 'codex' });
  const mux = {
    paneAlive: async () => false,
    sessionExists: async () => false,
    newWindow: async () => { throw new Error('spawn tmux ENOENT'); },
  };
  const before = (() => { try { return readFileSync(LOG_FILE, 'utf-8'); } catch { return ''; } })();
  const result = await dispatchOne(rec, { mux });
  assert.equal(result, 'retry');
  const after = readFileSync(LOG_FILE, 'utf-8');
  assert.match(after.slice(before.length), /new-window failed.*spawn tmux ENOENT/,
    'the failure must be visible in the log, not only in state');
});

// --- awaitReadyAndSend: the reopen ready-wait loop, extracted ---

test('awaitReadyAndSend: idle pane → sent, message typed into the pane', async () => {
  const agent = getAgent('claude');
  const sent = [];
  const mux = {
    capturePane: async () => '❯ \n',
    sendText: async (pane, text) => sent.push({ pane, text }),
  };
  const outcome = await awaitReadyAndSend(mux, '%9', agent, 'go on');
  assert.equal(outcome, 'sent');
  assert.deepEqual(sent, [{ pane: '%9', text: 'go on' }]);
});

test('awaitReadyAndSend: limit banner on the fresh pane → limit, nothing sent', async () => {
  const agent = getAgent('claude');
  const sent = [];
  const mux = {
    capturePane: async () => "⚠ You've hit your 5-hour limit\n· resets 9pm (UTC)\n> ",
    sendText: async (...a) => sent.push(a),
  };
  const outcome = await awaitReadyAndSend(mux, '%9', agent, 'go on');
  assert.equal(outcome, 'limit');
  assert.deepEqual(sent, []);
});

test('awaitReadyAndSend: never idle → timeout', async () => {
  const agent = getAgent('claude');
  const sent = [];
  const mux = {
    capturePane: async () => '✻ Cogitating… (esc to interrupt)',
    sendText: async (...a) => sent.push(a),
  };
  const outcome = await awaitReadyAndSend(mux, '%9', agent, 'go on', { timeoutMs: 50 });
  assert.equal(outcome, 'timeout');
  assert.deepEqual(sent, []);
});

test('awaitReadyAndSend: capturePane throwing keeps polling instead of crashing', async () => {
  const agent = getAgent('claude');
  let calls = 0;
  const mux = {
    capturePane: async () => { calls++; throw new Error('capture failed'); },
    sendText: async () => { throw new Error('must not send'); },
  };
  const outcome = await awaitReadyAndSend(mux, '%9', agent, 'go on', { timeoutMs: 50 });
  assert.equal(outcome, 'timeout');
  assert.ok(calls >= 1, 'capturePane was polled despite throwing');
});
