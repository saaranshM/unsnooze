// Opt-in integration test: a real isolated tmux server and real Unsnooze
// launcher/monitor/resumer, with a fixture CLI (no model calls or real tasks).
// UNSNOOZE_TEST_TMUX=1 node --test test/kimi-code-tmux.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('Kimi Code: real tmux detection → preview → same-pane wake → verified progress', {
  skip: process.env.UNSNOOZE_TEST_TMUX !== '1', timeout: 30000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unsnooze-code-e2e-'));
  const stateDir = join(dir, 'unsnooze');
  const codeDir = join(dir, 'code');
  const socket = join(dir, 'tmux.sock');
  const cwd = join(dir, 'project');
  const cli = fileURLToPath(new URL('../bin/unsnooze.js', import.meta.url));
  const sid = 'session_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  mkdirSync(cwd);
  mkdirSync(stateDir);
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ autoResume: true, guiWatch: false,
    notifications: false, agents: { kimi: true }, updateCheck: false }));
  const fixture = join(dir, 'fixture-kimi.mjs');
  writeFileSync(fixture, `#!${process.execPath}
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const root = process.env.UNSNOOZE_KIMI_CODE_DIR;
const id = '${sid}';
const base = join(root, 'sessions', 'wd_fixture', id);
mkdirSync(join(base, 'agents', 'main'), {recursive:true});
mkdirSync(join(root, 'locks', 'sessions'), {recursive:true});
writeFileSync(join(root, 'workspaces.json'), JSON.stringify({workspaces:{wd_fixture:{root:process.cwd()}}}));
writeFileSync(join(base, 'state.json'), JSON.stringify({id,cwd:process.cwd()}));
writeFileSync(join(root, 'locks', 'sessions', id+'.lock'), JSON.stringify({pid:process.pid}));
const wire = join(base, 'agents', 'main', 'wire.jsonl');
const event = e => appendFileSync(wire, JSON.stringify({agentId:'main',time:Date.now(),...e})+'\\n');
event({type:'turn.ended',reason:'failed',error:{code:'provider.api_error',message:"429 You've reached your 5-hour usage limit.",details:{statusCode:429}}});
console.log('Usage panel covering the banner\\n'+'footer\\n'.repeat(20)+'❯ ');
createInterface({input:process.stdin}).on('line', text => {
  writeFileSync(join(root, 'received.json'),JSON.stringify({text,id}));
  event({type:'usage.record',usage:{output:15}});
  console.log('fixture model output: resumed\\n❯ ');
});
`, { mode: 0o700 });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('UNSNOOZE_')));
  const env = { ...inherited, UNSNOOZE_STATE_DIR: stateDir, UNSNOOZE_KIMI_CODE_DIR: codeDir,
    UNSNOOZE_KIMI_DIR: join(dir, 'legacy'), UNSNOOZE_CLAUDE_DIR: join(dir, 'claude'),
    UNSNOOZE_KIMI_BIN: fixture, UNSNOOZE_SCRAPE_INTERVAL_MS: '100', UNSNOOZE_POLL_INTERVAL_MS: '100',
    UNSNOOZE_VERIFY_DELAY_MS: '200', UNSNOOZE_NOTIFICATIONS: 'off', UNSNOOZE_UPDATE_CHECK: 'off',
    UNSNOOZE_GUI_WATCH: 'off', UNSNOOZE_AUTO_RESUME: 'on', UNSNOOZE_RESET_MARGIN_MS: '0',
    UNSNOOZE_FALLBACK_RESET_MS: '2500', UNSNOOZE_PROBE_INTERVAL_MS: '100', UNSNOOZE_STAGGER_MS: '0' };
  delete env.TMUX; delete env.TMUX_PANE; delete env.UNSNOOZE_ACTIVE; delete env.UNSNOOZE_LEASE_ID;
  const tmux = (...args) => execFileSync('tmux', ['-S', socket, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const state = () => { try { return JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')); } catch { return {}; } };
  const wait = async predicate => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('timed out; ' + readFileSync(join(stateDir, 'unsnooze.log'), 'utf8'));
  };
  try {
    tmux('new-session', '-d', '-s', 'unsnooze-test', '-c', cwd, process.execPath, cli, '_run', 'kimi');
    const record = await wait(() => state().sessions?.[sid]);
    assert.equal(record.agent, 'kimi');
    assert.equal(record.status, 'stopped');
    assert.equal(record.pane, '%0');
    env.TMUX = `${socket},0,0`;
    const preview = execFileSync(process.execPath, [cli, 'preview', sid], { env, encoding: 'utf8' });
    assert.match(preview, /kimi/);
    assert.doesNotMatch(preview, /claude/);
    await wait(() => state().sessions?.[sid]?.status === 'resumed');
    assert.equal(state().sessions[sid].resumedBy, 'unsnooze');
    const received = JSON.parse(readFileSync(join(codeDir, 'received.json'), 'utf8'));
    assert.equal(received.id, sid);
    assert.match(received.text, /Continue where you left off/);
    assert.equal(tmux('list-panes', '-a', '-F', '#{pane_id}').trim(), '%0', 'no Claude/duplicate pane opened');
  } finally {
    try { tmux('kill-server'); } catch { /* already gone */ }
    const pid = state().resumerPid;
    if (pid && pid !== process.pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ } }
    // Give the monitor its final pane-liveness tick before removing fixtures.
    await new Promise(r => setTimeout(r, 300));
    rmSync(dir, { recursive: true, force: true });
  }
});
