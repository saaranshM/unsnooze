// Password source resolvers for fleet auth. Each is dependency-injected
// (platform/run/env/isTTY/readSecret) so every OS branch is testable
// anywhere. The SERVICE/ACCOUNT/VAR *names* may appear on argv; the secret
// itself never does — it only ever comes back on stdout/stdin.
import { execFileSync, spawnSync } from 'node:child_process';

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
