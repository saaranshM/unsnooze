// Wrapped sessions are created by name, and both tmux and zellij refuse a name
// that is already live (tmux: "duplicate session: unsnooze"). Concurrent
// `unsnooze <agent>` launches therefore need distinct names: the first holds
// the base, later ones take the first free `<base>-N`.

const MAX_PROBES = 64;

export function resolveSessionName(base, isTaken) {
  if (!isTaken(base)) return base;
  for (let n = 2; n <= MAX_PROBES; n += 1) {
    const candidate = `${base}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
  // Improbable, but a name must still be returned; the pid is unique among live
  // sessions even if a stale `<base>-<pid>` somehow lingers.
  return `${base}-${process.pid}`;
}

// Raised by launchWrapped when the multiplexer binary could not be started
// (spawnSync result.error). Distinct from a normal agent exit status so the
// launcher can degrade to an unwatched CLI without double-running a healthy agent.
export class SessionCreateError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'SessionCreateError';
    if (cause !== undefined) this.cause = cause;
  }
}
