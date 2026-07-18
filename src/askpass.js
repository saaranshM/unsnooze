// Password source resolvers for fleet auth. Each is dependency-injected
// (platform/run/env/isTTY/readSecret) so every OS branch is testable
// anywhere. The SERVICE/ACCOUNT/VAR *names* may appear on argv; the secret
// itself never does — it only ever comes back on stdout/stdin.
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, chmodSync, mkdirSync, renameSync } from 'node:fs';
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
  // Carry the exit code but NOT the command's stderr: a secret tool that
  // debug-prints the password to stderr must not leak it into an error
  // message. resolveCommand builds its message from `.status` alone.
  if (res.status !== 0) {
    const err = new Error(`command source exited ${res.status}`);
    err.status = res.status;
    throw err;
  }
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
  catch (e) {
    // Build the message from the exit code ONLY — never from e.message, which
    // may embed the command's own stderr (a secret tool debug-printing the
    // password to stderr would otherwise leak it into `hosts test`/logs).
    const code = Number.isInteger(e?.status) ? `exit ${e.status}` : 'could not run';
    throw new AuthError(`command source failed (${code}) — check the --cmd command`);
  }
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
    // C1 part 2: dropping BatchMode for password hosts (sshEnvForHost) means
    // ssh can now reach a yes/no host-key confirmation for an unknown host,
    // not just a password request. OpenSSH >=8.4 sets
    // SSH_ASKPASS_PROMPT=confirm for that case. Never hand back the secret
    // here — fail closed with a hint instead; the user has to `ssh <host>`
    // once manually to accept the host key before password auth can work.
    if (process.env.SSH_ASKPASS_PROMPT === 'confirm') {
      process.stderr.write(`unsnooze _askpass: host key not yet trusted for ${host} — run \`ssh ${host}\` once manually to accept it\n`);
      return 1;
    }
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
    const tmp = p + `.tmp.${process.pid}`;
    writeFileSync(tmp, `@echo off\r\n"${nodePath}" "${scriptPath}" _askpass %UNSNOOZE_ASKPASS_HOST%\r\n`);
    renameSync(tmp, p);   // atomic: never a torn/partial file visible at p
    return p;
  }
  const p = join(stateDir, 'askpass.sh');
  // Write to a temp file then rename over p — a crash/concurrent read never
  // observes a partially-written helper. Mode is applied to the tmp file at
  // creation (writeFileSync's mode option only takes effect on a new file);
  // chmodSync after the rename additionally corrects a pre-existing p left
  // with the wrong mode by an older run.
  const tmp = p + `.tmp.${process.pid}`;
  writeFileSync(tmp, `#!/bin/sh\nexec "${nodePath}" "${scriptPath}" _askpass "$UNSNOOZE_ASKPASS_HOST"\n`, { mode: 0o700 });
  renameSync(tmp, p);
  chmodSync(p, 0o700);
  return p;
}
