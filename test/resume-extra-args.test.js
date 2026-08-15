// resumeExtraArgs: the flags a user always passes by hand (a shell alias, a
// wrapper script) which a revival unsnooze performs itself would otherwise
// lose. A claude user who always runs --dangerously-skip-permissions gets a
// permission-prompting revival without them, which is as good as no revival.
//
// The value is argv, so it has to survive as argv. Splitting on whitespace
// turned `--append-system-prompt "Stay in this repo"` into five arguments and
// `"/tmp/My Project"` into two — quietly, at 3am, in the launch that was
// supposed to rescue the session.

import { test as baseTest, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-extra-args-'));
process.env.UNSNOOZE_STATE_DIR = DIR;

const { splitArgString, resolveResumeExtraArgs } = await import('../src/settings.js');

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const test = process.platform === 'win32'
  ? (name, fn) => baseTest(name, { skip: 'unix-only (/bin/sh comparison)' }, fn)
  : baseTest;

function writeConfig(config) {
  writeFileSync(join(DIR, 'config.json'), JSON.stringify(config));
}

// What a shell would produce, so "like a shell" is measured rather than claimed.
function shellSplit(text) {
  const out = execFileSync('/bin/sh', ['-c', `printf '%s<SEP>' ${text}`], { encoding: 'utf8' });
  return out.split('<SEP>').slice(0, -1);
}

test('a quoted argument stays one argument, exactly as a shell would split it', () => {
  for (const input of [
    '--dangerously-skip-permissions',
    '--append-system-prompt "Stay in this repo"',
    '--cwd "/tmp/My Project" -v',
    "--model 'claude sonnet'",
    '--a "one two"   --b   three',
    '--path /tmp/no-spaces',
  ]) {
    assert.deepEqual(splitArgString(input), shellSplit(input), input);
  }
});

test('escapes are honoured the way sh honours them', () => {
  assert.deepEqual(splitArgString('--msg a\\ b'), ['--msg', 'a b']);
  assert.deepEqual(splitArgString('--msg "a\\"b"'), ['--msg', 'a"b']);
  // Inside single quotes a backslash is literal, as in sh.
  assert.deepEqual(splitArgString("--msg 'a\\b'"), ['--msg', 'a\\b']);
});

test('an explicitly empty argument survives', () => {
  assert.deepEqual(splitArgString('--flag "" --after'), ['--flag', '', '--after']);
});

test('blank and whitespace-only settings contribute nothing', () => {
  assert.deepEqual(splitArgString(''), []);
  assert.deepEqual(splitArgString('    '), []);
});

test('the array form in config.json is used verbatim — no parsing at all', () => {
  writeConfig({ resumeExtraArgs: { claude: ['--append-system-prompt', 'Stay in this repo'] } });
  assert.deepEqual(resolveResumeExtraArgs('claude'), ['--append-system-prompt', 'Stay in this repo']);
});

test('the string form is split quote-aware', () => {
  writeConfig({ resumeExtraArgs: { claude: '--append-system-prompt "Stay in this repo"' } });
  assert.deepEqual(resolveResumeExtraArgs('claude'), ['--append-system-prompt', 'Stay in this repo']);
});

test('an unset agent, or one with nothing configured, adds nothing', () => {
  writeConfig({ resumeExtraArgs: { claude: '--x' } });
  assert.deepEqual(resolveResumeExtraArgs('codex'), []);
  assert.deepEqual(resolveResumeExtraArgs('nonesuch'), []);
  assert.deepEqual(resolveResumeExtraArgs(undefined), []);
});

test('an environment variable overrides the file, and is split the same way', () => {
  writeConfig({ resumeExtraArgs: { claude: '--from-file' } });
  process.env.UNSNOOZE_RESUME_EXTRA_ARGS_CLAUDE = '--from-env "two words"';
  try {
    assert.deepEqual(resolveResumeExtraArgs('claude'), ['--from-env', 'two words']);
  } finally {
    delete process.env.UNSNOOZE_RESUME_EXTRA_ARGS_CLAUDE;
  }
});

test('a malformed array drops the junk rather than passing it to the agent', () => {
  writeConfig({ resumeExtraArgs: { claude: ['--ok', 42, null, '', '--also-ok'] } });
  assert.deepEqual(resolveResumeExtraArgs('claude'), ['--ok', '--also-ok']);
});
