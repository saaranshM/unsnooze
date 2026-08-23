// The generated statusLine shim turns Claude Code's session_id into a
// filename. Before 1.17.0 it used the value verbatim, so a session_id
// containing a '/' walked the drop file out of ~/.claude/unsnooze.
//
// The traversal cases fail against the pre-fix shim. The well-formed-id case
// does NOT — it passed before too — and is kept deliberately: it is the only
// thing that would catch a gate tightened so far it rejects real session ids.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, mkdirSync,
  writeFileSync, chmodSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-shim-'));
process.env.UNSNOOZE_STATE_DIR = join(DIR, 'state');

const { writeStatuslineShimScript } = await import('../src/usage.js');

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

// The shim always drops into ~/.claude/unsnooze, so point HOME at a scratch
// dir and read the result from there.
function runShim(payload) {
  const home = mkdtempSync(join(DIR, 'home-'));
  const shim = writeStatuslineShimScript(join(DIR, 'shimdir'));
  const out = execFileSync(process.execPath, [shim], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, UNSNOOZE_STATUSLINE_ORIG: '' },
  });
  return { home, out, dropDir: join(home, '.claude', 'unsnooze') };
}

test('a well-formed session id still gets its own drop file', () => {
  const { dropDir } = runShim({
    session_id: 'ab12cd34-5678-90ef-ab12-cd3456789012',
    rate_limits: { five_hour: { used_percentage: 42 } },
  });
  const files = readdirSync(dropDir);
  assert.deepEqual(files, ['usage-ab12cd34-5678-90ef-ab12-cd3456789012.json']);
  const drop = JSON.parse(readFileSync(join(dropDir, files[0]), 'utf-8'));
  assert.equal(drop.rate_limits.five_hour.used_percentage, 42);
});

test('a traversing session id cannot escape the drop directory', () => {
  const { home, dropDir, out } = runShim({
    session_id: 'x/../../../../PWNED',
    rate_limits: { five_hour: { used_percentage: 7 } },
  });
  assert.ok(!existsSync(join(home, 'PWNED.json')), 'must not write outside ~/.claude/unsnooze');
  assert.ok(!existsSync(join(home, '..', 'PWNED.json')));
  assert.deepEqual(readdirSync(dropDir), ['usage-unknown.json'],
    'an id that is not filename-shaped falls back to "unknown"');
  assert.equal(out.trim(), 'unsnooze 7%', 'the statusline itself still renders');
});

test('an absolute session id cannot pick its own path', () => {
  const { dropDir } = runShim({ session_id: '/etc/unsnooze-pwned', rate_limits: {} });
  assert.deepEqual(readdirSync(dropDir), ['usage-unknown.json']);
});

test('a non-string session id does not crash the shim', () => {
  const { dropDir, out } = runShim({ session_id: { nested: true }, rate_limits: {} });
  assert.deepEqual(readdirSync(dropDir), ['usage-unknown.json']);
  assert.equal(out.trim(), 'unsnooze ?', 'no five_hour data renders as "?", not a crash');
});

test('the shim repairs a drop directory left world-readable by an older install', () => {
  // mkdir's mode is ignored for a directory that already exists, so every
  // pre-1.17.0 install kept 0755/0644 forever — the same gap the state dir
  // got a repair for, one directory over.
  if (process.platform === 'win32') return;
  const home = mkdtempSync(join(DIR, 'legacyhome-'));
  const dropDir = join(home, '.claude', 'unsnooze');
  mkdirSync(dropDir, { recursive: true });
  writeFileSync(join(dropDir, 'usage-old.json'), '{}');
  chmodSync(join(dropDir, 'usage-old.json'), 0o644);
  chmodSync(dropDir, 0o755);

  const shim = writeStatuslineShimScript(join(DIR, 'shimdir'));
  execFileSync(process.execPath, [shim], {
    input: JSON.stringify({ session_id: 'ab12cd34-5678-90ef-ab12-cd3456789012', rate_limits: {} }),
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, UNSNOOZE_STATUSLINE_ORIG: '' },
  });
  const mode = p => statSync(p).mode & 0o777;
  assert.equal(mode(dropDir), 0o700, 'the drop directory is narrowed on the next run');
  assert.equal(mode(join(dropDir, 'usage-ab12cd34-5678-90ef-ab12-cd3456789012.json')), 0o600);
});
