// dispatchOne / verifyOne decision logic with fake tmux.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-resumer-test-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';   // no desktop popups from tests
process.env.UNSNOOZE_READY_TIMEOUT_MS = '6000';   // keep the reopen poll short in tests
process.env.UNSNOOZE_VERIFY_DELAY_MS = '0';

const { dispatchOne, verifyOne, routeDispatchOutcome, runResumer } = await import('../src/resumer.js');
const { upsertSession, readState, setStatus, updateState } = await import('../src/state.js');

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
  return Object.values(state.sessions).find(s => s.sessionId === rec.sessionId || s.pane === rec.pane);
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
      UNSNOOZE_PANE_OWNER: 'unsnooze-test',
      UNSNOOZE_LEASE_ID: launchSpec.env.UNSNOOZE_LEASE_ID,
    });
  } finally {
    delete process.env.SECRET_API_KEY;
    delete process.env.UNRELATED_DAEMON_SETTING;
  }
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
  assert.equal(readState().sessions[rec.key].status, 'resumed');
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
      mux: liveTmux(sent), fingerprint: () => WS_AFTER, notifier: (t, m) => toasts.push(m),
    });
    assert.equal(result, 'held');
    assert.equal(sent.length, 0);
    const after1 = readState().sessions[rec.key];
    assert.equal(after1.workspaceHold, true);
    assert.match(after1.holdReason, /HEAD/);
    assert.equal(toasts.length, 1);
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
      newWindow: async (_session, _cwd, spec) => {
        launchSpec = spec;
        return { pane: '9', paneOwner: 'revive' };
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

test('defer outcome routing keeps busy, retry, and held semantically distinct', () => {
  const counts = new Map();
  const busy = seed({ pane: '%47' });
  routeDispatchOutcome('busy', busy, counts, { maxBusyDefers: 0 });
  assert.equal(readState().sessions[busy.key].status, 'resumed');

  const retry = seed({ pane: '%48' });
  routeDispatchOutcome('retry', retry, counts);
  assert.equal(readState().sessions[retry.key].status, 'stopped');
  assert.equal(readState().sessions[retry.key].attempts, 1);

  const held = seed({ pane: '%49' });
  routeDispatchOutcome('held', held, counts);
  assert.equal(readState().sessions[held.key].status, 'stopped');
  assert.equal(readState().sessions[held.key].attempts, 0);
});
