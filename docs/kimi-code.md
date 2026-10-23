# Kimi Code compatibility

The local `fix/kimi-code-adapter` branch supports Kimi Code 2.3.0 alongside
the legacy Python `kimi-cli`. Both executables are named `kimi`, but their
session formats and resume arguments differ.

Kimi Code stores workspace mappings in `~/.kimi-code/workspaces.json`, session
metadata in `sessions/<workspace>/session_<uuid>/state.json`, and main-agent
events in `agents/main/wire.jsonl`. Unsnooze reads terminal `turn.ended` quota
errors and successful `usage.record` output from that wire. Child-agent failure
notifications, retries, quoted errors, and user prompts do not count as parent
stops or successful recoveries. A live pane's lease PID is matched against the
Kimi session lock, so simultaneous conversations in the same directory are not
guessed from modification times.

Live sessions receive the wake message in their existing pane. A dead Code
session reopens with `kimi --session session_<uuid>` and receives the prompt
once its TUI is ready. Headless recovery uses `--prompt` instead. Missing Code
session IDs fail explicitly instead of continuing another conversation. Legacy
Python sessions retain `~/.kimi`, UUID discovery, and `-r` recovery.

The Sessions view shows `watching kimi pane %N` from the live process lease.
Older recovery records are displayed separately; they do not identify the
agent currently occupying a session. Pane deduplication also checks the agent
and known lease generation.

## Reset timing

Kimi's quota error does not include an exact reset timestamp. This change keeps
Unsnooze's existing fallback: pane/transcript probes with backoff, then a wake
attempt at the fallback ceiling (normally five hours). It does not query the
account usage API or refresh credentials. Recovery can therefore lag the real
quota reset; `unsnooze resume-now <session-id>` can retry the detected Kimi stop
as soon as the user knows allowance is available. A newer failed turn remains
stopped; new parent model output is required before reporting success.

`UNSNOOZE_KIMI_CODE_DIR` overrides the Code data directory. The existing
`UNSNOOZE_KIMI_DIR` selects a legacy directory; when explicitly set without a
Code override, it suppresses Code discovery. Do not change these for a normal
installation.

## Run from this checkout

```sh
npm ci
npm test
UNSNOOZE_TEST_TMUX=1 node --test test/kimi-code-tmux.test.js
npm uninstall -g unsnooze
npm link
node bin/unsnooze.js install --yes --daemon
```

`npm link` exposes this checkout as the `unsnooze` command. The install step
refreshes shell wrappers, enabled hooks, and the existing daemon service.
Already-running monitors must be restarted on this checkout while retaining
their mux, pane, agent, lease ID, and working directory. Do not restart the
agents or kill their tmux sessions. An old interactive shell's wrapper path
continues to work through the npm link; new shells use the source path.

To return to the published build, stop the Unsnooze daemon/monitors, unlink the
local package, install the desired published version, rerun its install step,
and restart the monitors with their original pane/lease arguments. Preserve
`~/.unsnooze`; uninstalling an npm package does not require purging session data.

## Validation

The regression tests cover the actual Code 2.3.0 error shape and metadata,
hidden banners, parent/subagent separation, progress after manual continuation,
same-directory session ambiguity, a failed recovery, and restored history.
The opt-in tmux test runs the real launcher, monitor, preview and resumer on a
private tmux socket with a fixture CLI. It checks same-pane delivery and
verified recovery without making model calls or touching user sessions.

Format references: [Kimi Code source](https://github.com/MoonshotAI/kimi-code)
and the installed 2.3.0 CLI's `--help` and session files. Account reset-time
discovery remains future work.
