// Password source resolvers for fleet auth. Each is dependency-injected
// (platform/run/env/isTTY/readSecret) so every OS branch is testable
// anywhere. The SERVICE/ACCOUNT/VAR *names* may appear on argv; the secret
// itself never does — it only ever comes back on stdout/stdin.
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class AuthError extends Error {
  constructor(msg) { super(msg); this.name = 'AuthError'; this.needsAuth = true; }
}

function defaultRun(bin, args, opts) {
  return execFileSync(bin, args, { encoding: 'utf-8', ...opts });
}

// Shell-based runner for the `command` source only: entry.cmd is the user's
// own configured, trusted string (git-credential-helper style, e.g.
// `credential.helper = !cmd`) — there is no untrusted input crossing this
// boundary, so shell-execution is safe and lets users write pipelines,
// quoted args, etc. Node picks /bin/sh on unix, cmd.exe on Windows.
function defaultShellRun(cmd, opts) {
  const res = spawnSync(cmd, { shell: true, encoding: 'utf-8', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`exited ${res.status}: ${res.stderr || ''}`.trim());
  return res.stdout;
}

const trimPw = (s) => String(s ?? '').replace(/\r?\n$/, '');

export function resolveEnv(entry, { env = process.env } = {}) {
  const v = env[entry.env];
  if (v == null || v === '') throw new AuthError(`env var ${entry.env} is not set`);
  return trimPw(v);
}

// entry.cmd is the user's own trusted command (git-credential-helper style)
// — shell-executed for flexibility (quoting, pipes), not argv-split.
export function resolveCommand(entry, { run = defaultShellRun } = {}) {
  const cmd = String(entry.cmd || '').trim();
  if (!cmd) throw new AuthError('empty command source');
  let out;
  try { out = run(cmd, { shell: true }); }
  catch (e) { throw new AuthError(`command source failed: ${e.message}`); }
  const pw = trimPw(out);
  if (!pw) throw new AuthError('command source produced no output');
  return pw;
}

// Built-in keychain support is macOS-only (Keychain via `security`). On
// Windows and Linux there is no safe, dependency-free built-in retrieval
// path, so callers are pointed at --source command with a platform-native
// one-liner (pass/secret-tool/powershell).
export function resolveKeychain(entry, { platform = process.platform, run = defaultRun } = {}) {
  if (platform === 'darwin') {
    try {
      return trimPw(run('security', ['find-generic-password', '-s', entry.service, '-a', entry.account, '-w']));
    } catch {
      throw new AuthError(`keychain miss for ${entry.service}/${entry.account}`);
    }
  }
  throw new AuthError(
    `no built-in keychain on ${platform} — use --source command (e.g. \`pass show\`, \`secret-tool lookup\`, or \`powershell -Command "..."\`)`,
  );
}

export async function resolvePrompt(entry, { isTTY = process.stdin.isTTY, readSecret } = {}) {
  if (!isTTY) throw new AuthError('prompt source needs an interactive terminal — use env/command/keychain for the daemon');
  return await readSecret(`password for ${entry.dest || 'host'}: `);
}

export async function resolveSecret(entry, deps = {}) {
  switch (entry.source) {
    case 'env': return resolveEnv(entry, deps);
    case 'command': return resolveCommand(entry, deps);
    case 'keychain': return resolveKeychain(entry, deps);
    case 'prompt': return await resolvePrompt(entry, deps);
    default: throw new AuthError(`unknown source ${entry.source}`);
  }
}

// No-echo password read from the controlling terminal. Rejects when stdin is
// not a TTY (piped/daemon) — the caller must fall back to a stored source.
// Every rejection is an AuthError (never a bare Error) so resolvePrompt's
// caller can uniformly treat a failed read as "needs auth", not a crash.
export function readSecret(prompt, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) return reject(new AuthError('no terminal for prompt'));
    output.write(prompt);
    let buf = '';
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      try { input.setRawMode(false); } catch { /* ignore */ }
      input.pause();
      input.removeListener('data', onData);
      input.removeListener('error', onError);
      output.write('\n');
      err ? reject(err) : resolve(val);
    };
    const onError = (e) => done(e instanceof AuthError ? e : new AuthError(`cannot read password: ${e.message}`));
    const onData = (d) => {
      const s = d.toString('utf8');
      for (const ch of s) {
        if (ch === '\n' || ch === '\r' || ch === '\x04') return done(null, buf);
        if (ch === '\x03') return done(new AuthError('cancelled'));
        if (ch === '\x7f' || ch === '\b') { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    input.resume();
    input.setEncoding('utf8');
    try { input.setRawMode(true); } catch (e) { return reject(new AuthError(`cannot read password: ${e.message}`)); }
    input.on('data', onData);
    input.on('error', onError);
  });
}

export async function cmdAskpass(args = []) {
  const host = process.env.UNSNOOZE_ASKPASS_HOST ?? args[0];
  try {
    const { readHosts } = await import('./fleet.js');
    const entry = readHosts()[host];
    if (!entry || entry.auth !== 'password') {
      process.stderr.write(`unsnooze _askpass: no password host ${host}\n`);
      return 1;
    }
    const secret = await resolveSecret(entry, { readSecret });
    process.stdout.write(secret);   // bare secret, ssh reads first line — nothing else to stdout
    return 0;
  } catch (e) {
    process.stderr.write(`unsnooze _askpass: ${e.message}\n`);
    return 1;
  }
}

// Provision the file SSH_ASKPASS points at (see design §5c). The helper
// itself reads the host from UNSNOOZE_ASKPASS_HOST (set in the ssh child env
// by Task 5) because ssh controls the helper's argv — it passes only the
// prompt text, never the host.
export function ensureAskpassHelper({ platform = process.platform, stateDir, nodePath = process.execPath, scriptPath }) {
  mkdirSync(stateDir, { recursive: true });
  if (platform === 'win32') {
    // Native ssh.exe needs a real exe; unix-like win ssh (Git/WSL) accepts a script.
    // The resolution ladder (design §5c) is finalized in Task 7's cross-platform pass;
    // here we write the unix-style .cmd wrapper used by Git-Bash/WSL and MSYS ssh.
    const p = join(stateDir, 'askpass.cmd');
    writeFileSync(p, `@echo off\r\n"${nodePath}" "${scriptPath}" _askpass %UNSNOOZE_ASKPASS_HOST%\r\n`);
    return p;
  }
  const p = join(stateDir, 'askpass.sh');
  writeFileSync(p, `#!/bin/sh\nexec "${nodePath}" "${scriptPath}" _askpass "$UNSNOOZE_ASKPASS_HOST"\n`);
  chmodSync(p, 0o700);
  return p;
}
