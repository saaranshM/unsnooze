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

// Raised once the agent may already be running: the multiplexer accepted the
// command that starts it, and something failed afterwards (attaching a client,
// most often). The distinction matters because the launcher's response to a
// failed wrap is to run the agent again, unwatched — which is right when the
// agent definitely never started, and produces two live agents from one
// `unsnooze claude` when it did.
export class AgentDispatchedError extends Error {
  constructor(message, { session = null, mux = null, cause } = {}) {
    super(message);
    this.name = 'AgentDispatchedError';
    this.session = session;
    this.mux = mux;
    if (cause !== undefined) this.cause = cause;
  }
}

// How a user reaches a session by hand. Lives here rather than in reap.js so
// the launch path can name it without importing reap (and, through it, the
// whole state layer) into the hot path of every `unsnooze claude`.
export function attachHint(muxName, sessionName) {
  if (!sessionName) return null;
  // cmux has no joinable named-session model (see multiplexers/cmux.js): there
  // is no command that attaches to a surface from outside cmux, so omit the
  // hint rather than print a `tmux attach` that would silently do nothing.
  if (muxName === 'cmux') return null;
  if (muxName === 'herdr') return `herdr session attach ${sessionName}`;
  if (muxName === 'zellij') return `zellij attach ${sessionName}`;
  return `tmux attach -t ${sessionName}`;
}
