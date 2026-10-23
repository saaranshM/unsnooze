# Kimi Code compatibility

The Kimi adapter supports Kimi Code 2.3.0 alongside the legacy Python
`kimi-cli`. Both executables are named `kimi`, but their
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

Kimi's quota error does not include an exact reset timestamp. For a managed
Kimi Code model using file-backed OAuth credentials, Unsnooze reads the
configured official `/coding/v1/usages` endpoint on scheduler polls (normally
every 30 seconds). It uses the absolute `reset_time` of exhausted windows,
including monthly constraints, instead of waiting for the next fallback probe.
The existing reset safety margin applies to future reset timestamps. When the
API confirms allowance is already available, the stop becomes due immediately
and passes through the normal ownership, busy, and workspace guards.

The regional endpoint and credential slot come from Kimi's `config.toml`.
Only the official HTTPS `api.kimi.com` and `api.kimi.ai` hosts are accepted;
redirects are rejected. Tokens are read in memory, never copied into Unsnooze
state or logs, and never refreshed or written by Unsnooze. Responses are cached
for 30 seconds per account. Unknown models, custom endpoints, keyring storage,
missing/expired credentials, malformed responses, and network failures retain
the existing fallback probes. A newer failed turn remains stopped; new parent
model output is required before reporting success.

`UNSNOOZE_KIMI_CODE_DIR` overrides the Code data directory. The existing
`UNSNOOZE_KIMI_DIR` selects a legacy directory; when explicitly set without a
Code override, it suppresses Code discovery. Do not change these for a normal
installation.

## Mouse scrolling

Unsnooze enables tmux mouse handling inside sessions it creates. In Kimi's
regular terminal mode, wheel-up enters tmux scrollback rather than recalling
the previous prompt. Press `q` to leave scrollback and return to the live input.
Automatic wake messages wait while a pane is in scrollback, then resume through
the normal scheduler after copy mode is closed.
Applications that request mouse events keep receiving them through tmux's
normal bindings.

The default is session-local: global tmux options, wheel bindings, existing
per-session mouse choices, and borrowed user-managed sessions are preserved.
This also applies to new recovery sessions. A running session can be updated
without restarting Kimi using `tmux set-option -t <session> mouse on`.

## Development checks

```sh
npm ci
npm test
UNSNOOZE_TEST_TMUX=1 node --test test/kimi-code-tmux.test.js
python3 scripts/e2e-tmux-mouse.py
```

## Validation

The regression tests cover the actual Code 2.3.0 error shape and metadata,
hidden banners, parent/subagent separation, progress after manual continuation,
same-directory session ambiguity, a failed recovery, and restored history.
The opt-in tmux test runs the real launcher, monitor, preview and resumer on a
private tmux socket with a fixture CLI. It checks same-pane delivery and
verified recovery without making model calls or touching user sessions.

Format references: [Kimi Code source](https://github.com/MoonshotAI/kimi-code)
and the installed 2.3.0 CLI's `--help` and session files. The usage API schema
follows Kimi Code's `packages/oauth/src/managed-usage.ts`.
