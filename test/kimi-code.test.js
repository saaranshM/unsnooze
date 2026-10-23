import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-kimi-code-'));
process.env.UNSNOOZE_STATE_DIR = join(DIR, 'unsnooze');
process.env.UNSNOOZE_KIMI_CODE_DIR = join(DIR, 'code');
process.env.UNSNOOZE_KIMI_DIR = join(DIR, 'legacy');
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_VERIFY_DELAY_MS = '0';
const { default: kimi } = await import('../src/agents/kimi.js');
const { codeSession, readCodeState, hasCodeProgressAfter, parseCodeEvent } = await import('../src/agents/kimi-code.js');
const { detectLimit, detectAgentLimit } = await import('../src/patterns.js');
const { createMonitor } = await import('../src/monitor.js');
const { readState, upsertSession, setStatus } = await import('../src/state.js');
const { planFor, dispatchOne, verifyOne, awaitReadyAndSend, refreshProviderReset } = await import('../src/resumer.js');
const { transcriptPath } = await import('../src/sessions.js');
after(() => rmSync(DIR, { recursive: true, force: true }));

const root = process.env.UNSNOOZE_KIMI_CODE_DIR;
const MESSAGE = "429 You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.";
const HIDDEN = '╭ Usage ─────────╮\n' + '│ plan usage │\n'.repeat(20) + '╰───────────────╯\n│ > │\nNever Ask · K3-256k · context: 55%\n';
const workspaces = {};
let counter = 0;
function fixture({ cwd } = {}) {
  const n = ++counter;
  cwd ||= join(DIR, `project-${n}`);
  const workspace = `wd_project_${n}`;
  const id = `session_aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, '0')}`;
  const path = join(root, 'sessions', workspace, id);
  mkdirSync(join(path, 'agents', 'main'), { recursive: true });
  workspaces[workspace] = { root: cwd };
  writeFileSync(join(root, 'workspaces.json'), JSON.stringify({ workspaces }));
  writeFileSync(join(path, 'state.json'), JSON.stringify({ id, cwd, updatedAt: Date.now() - 86400000 }));
  const wire = join(path, 'agents', 'main', 'wire.jsonl');
  writeFileSync(wire, '');
  const append = (entry) => appendFileSync(wire, JSON.stringify({ agentId: 'main', ...entry }) + '\n');
  const stop = at => append({ type: 'turn.ended', time: at, reason: 'failed', error: {
    code: 'provider.api_error', message: MESSAGE, details: { statusCode: 429 },
  } });
  const progress = at => append({ type: 'usage.record', time: at, usage: { output: 12 } });
  return { id, cwd, path, wire, append, stop, progress, pane: `%${800 + n}` };
}

test('recognizes the actual Kimi Code terminal banner, not quoted/subagent prose', () => {
  assert.equal(detectLimit(`Error: [provider.api_error] ${MESSAGE}`, 12, kimi.patterns).hit, true);
  assert.equal(detectLimit(`● Goal paused after provider API error: ${MESSAGE}`, 12, kimi.patterns).limitType, '5h');
  assert.equal(detectLimit(`✗ coder agent failed in background (${MESSAGE})`, 12, kimi.patterns).hit, false);
  assert.equal(detectLimit(`The docs say: "${MESSAGE}"`, 12, kimi.patterns).hit, false);
  assert.equal(parseCodeEvent({ agentId: 'main', type: 'turn.step.retrying', time: 1, message: MESSAGE }).kind, 'busy');
  assert.equal(parseCodeEvent({ agentId: 'agent-1', type: 'turn.ended', time: 1, reason: 'failed', error: { code: 'provider.api_error', message: MESSAGE } }), null);
});

test('discovers Code state without UUID or md5 layout assumptions; locks disambiguate same-cwd sessions', () => {
  const a = fixture();
  assert.equal(codeSession({ cwd: a.cwd }).id, a.id);
  const b = fixture({ cwd: a.cwd });
  assert.equal(codeSession({ cwd: a.cwd }), null, 'do not guess which terminal owns this workdir');
  mkdirSync(join(root, 'locks', 'sessions'), { recursive: true });
  writeFileSync(join(root, 'locks', 'sessions', `${b.id}.lock`), JSON.stringify({ pid: 123 }));
  assert.equal(codeSession({ cwd: a.cwd, pid: 123 }).id, b.id);
  assert.equal(codeSession({ cwd: a.cwd, pid: 456 }), null);
  assert.equal(codeSession({ cwd: '/wrong', sessionId: a.id }), null);
  assert.equal(codeSession({ sessionId: '../../escape' }), null);
});

test('reopens the exact Code conversation with a TUI, or argv prompt for headless', () => {
  const f = fixture();
  assert.deepEqual(kimi.resumeArgs(f.id, 'continue', { canType: true, cwd: f.cwd }), {
    args: ['--session', f.id], messageViaPane: true,
  });
  assert.deepEqual(kimi.resumeArgs(f.id, 'continue', { canType: false, cwd: f.cwd }), {
    args: ['--session', f.id, '--prompt', 'continue'], messageViaPane: false,
  });
  assert.throws(() => kimi.resumeArgs('session_00000000-0000-4000-8000-000000000000', 'continue'), /refusing/);
});

test('durable stop survives footer/usage overlay; newer output overrides old errors and quoted notifications', () => {
  const f = fixture();
  const t = Date.now() - 10000;
  f.stop(t);
  const rec = { cwd: f.cwd, sessionId: f.id };
  assert.equal(detectAgentLimit(HIDDEN, 12, kimi, rec).bannerAt, t);
  assert.equal(hasCodeProgressAfter(rec, t), false);
  f.progress(t + 1000);
  f.append({ type: 'context.append_message', time: t + 2000, message: { role: 'user', content: MESSAGE } });
  assert.equal(detectAgentLimit(`Error: [provider.api_error] ${MESSAGE}`, 12, kimi, rec).hit, false);
  assert.equal(hasCodeProgressAfter(rec, t), true);
  f.stop(t + 3000);
  assert.equal(hasCodeProgressAfter(rec, t), false, 'a later failed retry is not progress');
  f.append({ type: 'llm.request', time: t + 4000 });
  assert.equal(readCodeState(rec).busy, true);
});

test('a large trailing wire record and a partial write cannot hide the last stop', () => {
  const f = fixture();
  f.stop(Date.now());
  f.append({ type: 'context.append_message', time: Date.now(), message: 'x'.repeat(300000) });
  appendFileSync(f.wire, '{"type":');
  assert.equal(readCodeState({ cwd: f.cwd, sessionId: f.id }).limit.hit, true);
});

test('monitor records Kimi from the main wire even with a hidden banner and Claude stop in the same cwd', async () => {
  const f = fixture();
  const t = Date.now() - 10000;
  f.stop(t);
  const claudeId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const claudePath = transcriptPath(f.cwd, claudeId);
  mkdirSync(join(claudePath, '..'), { recursive: true });
  writeFileSync(claudePath, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
    message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your limit · resets 11pm (UTC)" }] }, isApiErrorMessage: true }) + '\n');
  const sent = [];
  const mux = { paneAlive: async () => true, capturePane: async () => HIDDEN,
    sessionForPane: async () => 'unsnooze', sendText: async (_p, text) => sent.push(text) };
  const monitor = createMonitor({ pane: f.pane, cwd: f.cwd, agent: kimi, mux,
    notifier: () => {}, versionSkewed: () => false });
  await monitor._tick();
  const rec = Object.values(readState().sessions).find(r => r.pane === f.pane);
  assert.equal(rec.agent, 'kimi');
  assert.equal(rec.sessionId, f.id);
  assert.equal(rec.bannerAt, t);
  await monitor._tick();
  assert.equal(readState().sessions[rec.key].status, 'stopped');
  f.progress(Date.now());
  await monitor._tick();
  assert.equal(readState().sessions[rec.key].status, 'resumed');
  assert.deepEqual(sent, []);
});

test('live recovery injects into the Kimi pane and verifies model output; old error alone is not a new failure', async () => {
  const f = fixture();
  const t = Date.now() - 10000;
  f.stop(t);
  const initial = { sessionId: f.id, agent: 'kimi', cwd: f.cwd, pane: f.pane,
    mux: 'tmux', paneOwner: null, status: 'stopped', detectedAt: t, bannerAt: t,
    resetAt: Date.now() - 1, resetSource: 'absolute', attempts: 0, limitType: '5h' };
  upsertSession(initial);
  const rec = readState().sessions[f.id];
  const sent = [];
  const mux = { paneAlive: async () => true, capturePane: async () => HIDDEN,
    paneCurrentCommand: async () => 'kimi', sendText: async (_pane, text) => {
      sent.push({ pane: _pane, text });
      f.append({ type: 'llm.request', time: Date.now() });
    } };
  assert.equal((await planFor(rec, { mux, matchesLease: async () => true })).action, 'inject');
  await dispatchOne(rec, { mux, matchesLease: async () => true, notifier: () => {} });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].pane, f.pane);
  assert.equal(await verifyOne(rec.key, { resolveMux: () => mux }), 'pending');
  assert.equal(readState().sessions[rec.key].status, 'resuming');
  f.progress(Date.now() + 1);
  assert.equal(await verifyOne(rec.key, { resolveMux: () => mux }), 'resumed');
});

test('already-resumed Kimi gets no extra wake; a recycled Claude pane never merges with Kimi', async () => {
  const f = fixture();
  const t = Date.now() - 10000;
  upsertSession({ sessionId: 'old-claude', agent: 'claude', cwd: f.cwd, pane: f.pane, mux: 'tmux',
    status: 'stopped', detectedAt: t, leaseId: 'old' });
  upsertSession({ sessionId: f.id, agent: 'kimi', cwd: f.cwd, pane: f.pane, mux: 'tmux',
    status: 'stopped', detectedAt: t, bannerAt: t, resetAt: 1, resetSource: 'absolute', leaseId: 'new' });
  assert.equal(readState().sessions['old-claude'].agent, 'claude');
  const rec = readState().sessions[f.id];
  assert.equal(rec.agent, 'kimi');
  f.progress(t + 1000);
  const mux = { paneAlive: async () => { throw new Error('must not inspect or type into active pane'); } };
  assert.equal((await planFor(rec, { mux })).action, 'none');
  assert.equal(await dispatchOne(rec, { mux }), 'already-resumed');
});

test('a new quota error after wake stays stopped instead of being reported as resumed', async () => {
  const f = fixture();
  const attempt = Date.now() - 2000;
  f.stop(attempt + 1000);
  upsertSession({ sessionId: f.id, agent: 'kimi', cwd: f.cwd, pane: f.pane, mux: 'tmux',
    status: 'resuming', detectedAt: attempt - 1000, bannerAt: attempt - 1000,
    lastAttemptAt: attempt, attempts: 0 });
  await verifyOne(f.id, { resolveMux: () => ({ capturePane: async () => HIDDEN }) });
  const rec = readState().sessions[f.id];
  assert.equal(rec.status, 'stopped');
  assert.equal(rec.bannerAt, attempt + 1000);
  assert.equal(rec.attempts, 1);
});

test('restored Code history cannot block the first wake prompt in a reopened pane', async () => {
  const f = fixture();
  f.stop(Date.now() - 10000);
  const sent = [];
  const mux = { capturePane: async () => HIDDEN, sendText: async (pane, text) => sent.push({ pane, text }) };
  const outcome = await awaitReadyAndSend(mux, f.pane, kimi, 'Continue', {
    context: { cwd: f.cwd, sessionId: f.id }, timeoutMs: 3000,
  });
  assert.equal(outcome, 'sent');
  assert.deepEqual(sent, [{ pane: f.pane, text: 'Continue' }]);
});

test('session display names the current leased agent and excludes recycled ownership', async () => {
  const { writeLease, livePaneAgents, processBirth } = await import('../src/lease.js');
  const { formatSessionsTui } = await import('../src/tui.js');
  const base = { mux: 'tmux', pane: '%display', paneOwner: null, pid: process.pid, pidBirth: processBirth(process.pid) };
  writeLease({ ...base, leaseId: 'old-display', agent: 'claude' });
  writeLease({ ...base, leaseId: 'new-display', agent: 'kimi' });
  const liveAgents = await livePaneAgents('tmux', ['%display'], { mux: {
    paneAlive: async () => true, paneOwnerStamp: async () => 'new-display',
  } });
  assert.deepEqual(liveAgents, [{ agent: 'kimi', pane: '%display' }]);
  const rendered = formatSessionsTui([{ name: 'unsnooze', mux: 'tmux', panes: ['%display'], liveAgents,
    records: [{ agent: 'claude', pane: '%gone', status: 'stopped', cwd: '/tmp/old' }] }], { color: false });
  assert.match(rendered, /watching kimi in unsnooze pane %display/);
  assert.match(rendered, /claude.*pane %gone/);
});

test('the old time-less banner cannot replace a provider-confirmed reset with fallback probes', async () => {
  const f = fixture();
  const at = Date.now() - 1000;
  f.append({ type: 'llm.request', time: at - 1000, modelAlias: 'kimi-code/test' });
  f.stop(at);
  assert.equal(readCodeState({ cwd: f.cwd, sessionId: f.id }).modelAlias, 'kimi-code/test');
  const mux = { paneAlive: async () => true, capturePane: async () => HIDDEN };
  const monitor = createMonitor({ pane: f.pane, cwd: f.cwd, agent: kimi, mux,
    notifier: () => {}, versionSkewed: () => false });
  await monitor._tick();
  const rec = readState().sessions[f.id];
  const reset = Date.now() + 4 * 3600000;
  await refreshProviderReset(rec, { marginMs: 0, reader: async () => ({ available: false, resetAt: reset }) });
  await monitor._tick();
  assert.equal(readState().sessions[f.id].resetSource, 'absolute');
  assert.equal(readState().sessions[f.id].resetAt, reset);
});
