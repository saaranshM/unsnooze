# Changelog

## Unreleased

## 1.14.0 — 2026-07-19

- **Queued prompts**: `unsnooze prompt add [--agent id] [--project path]
  [--at time|--now] <text...>` (plus `list`/`remove`/`clear`) queues a
  one-shot prompt that spawns a **brand-new** agent session in a project
  directory once a usage limit clears. `--now`/`--at` (epoch, ISO-8601,
  `+2h30m`, or a bare clock time) skip the reset wait; with no reset signal
  at all, a `next-reset` entry delivers on the very next daemon tick and
  `prompt add` prints a notice to that effect. Delivery is verified against
  a fresh limit banner and backs off on failure — the same backoff floor
  applies to every mode, capped at 5 attempts (same as resume) before an
  entry is marked failed. `autoResume` does not gate delivery. Dashboard:
  a new **Prompts** tab (`7`) — list, `a` to add, `d`/`x` to remove — plus a
  queued-count hint on the Status tab. Fleet: `--host <name>` relays the
  same subcommands to a registered host's own queue (`--project`/`--agent`
  required, everything re-validated server-side); the new `remoteQueue`
  setting (default on) lets a host opt out of all queue traffic, answering
  a typed `disabled` instead of silently dropping it.
- **Fleet password auth**: hosts can now use a password instead of an ssh key
  — `unsnooze hosts add <name> <dest> --auth password --source
  prompt|env|keychain|command` (`prompt` is interactive no-echo and the
  default; `env`/`keychain`/`command` are daemon-capable). `keychain` is a
  macOS-only built-in; Windows and Linux use `--source command` with a
  per-OS recipe (Linux `pass`/`secret-tool`, Windows `powershell`/`op read`;
  `security` is the macOS recipe — see README's per-OS table). `unsnooze hosts test <name>` pre-flights a host without
  ever printing its secret. Auth-gapped hosts render as `needs-auth` in
  `fleet`/the dashboard, distinct from `unreachable`. Security: the password
  never touches argv, `ps`, or unsnooze's own environment — it flows through
  OpenSSH's `SSH_ASKPASS` hook, helper-stdout → ssh, in-process; unsnooze
  stores no plaintext itself; keys stay the unchanged, BatchMode-hardened
  default.
- **Fleet — sessions on every machine, over your own SSH**: `unsnooze hosts
  [add|rm|list]` registers ssh destinations; `unsnooze fleet [--json]` and
  the dashboard's new **Fleet** tab fan out to every host in parallel and
  show each one's tracked sessions (state, reset countdown, attach hint),
  with a bounded-concurrency ssh pool, per-host timeouts, and a 24h stale
  cache so one dead box never blocks the rest. `unsnooze _remote` is the
  single remote entrypoint (`status`/`resume`/`cancel`), safe to lock to an
  `authorized_keys` forced command; `unsnooze status --json` and a shared
  resume core back both the local and remote paths. Security posture: no
  listening ports, no custom auth, no tokens — transport is plain OpenSSH
  with host-key checking never weakened; the remote is always the one that
  types, under its own gates; and every field a remote returns is
  control-character-stripped, length-capped, and extracted into fresh
  objects before it touches your terminal or state.
- **Dashboard mouse support**: click tabs and session rows, wheel-scroll the
  status/sessions lists and a real scrollback window in Logs, clickable
  footer hints (refresh / help / quit). Full keyboard parity kept; `m` (or
  `mouse` config / `UNSNOOZE_MOUSE`) toggles it live so terminal text
  selection is one keypress away. Tracking modes are always cleared on exit,
  crash, and Ctrl-Z — no hijacked mouse after quit.

## 1.13.0 — 2026-07-17

- **`unsnooze usage` — know the wall before you hit it**: burn-rate &
  time-to-limit forecast per agent × window. Every figure carries its
  provenance — `(exact)` from Codex rollouts or the opt-in Claude statusline
  shim, `(calibrated from N stops)` learned from unsnooze's own recorded
  limit stops, or `(estimated)` while calibrating. Weighted token burn
  (cache reads ×0.1) over active minutes, account-wide including subagent
  transcripts, per Opus/Sonnet bucket on Max plans. ETA shown as a band,
  cross-checked against the observed reset time — never a false-precision
  minute, never a blind now+5h.
- **Pre-wall warnings from the daemon**: hybrid thresholds (80/95% and
  ≤30/≤10 min to the wall at current pace), deduped per window instance,
  with a `/compact now` nudge sized from the same context estimator as
  `unsnooze status`. Notify-only — unsnooze still never types anything you
  didn't configure.
- **`unsnooze usage --install-statusline`**: opt-in shim that persists
  Claude's exact server-side percentages; chains your existing statusline
  command (backed up once, restored on uninstall).
- **Live dashboard**: `unsnooze dashboard` (also `status`/`usage` on an
  interactive TTY) — full-screen Ink TUI with Status, Usage, Sessions,
  Doctor and Logs tabs, animated ❯ z z z brand mark, help overlay (`?`),
  and a compact layout down to 80×24. Pipes and `--json` stay plain.
- **Fix**: undated limit banners crossing midnight ("resets 12:04am" seen
  at 9pm) parsed as already-past and were dropped or resumed due-now into a
  still-live limit; they now roll to tomorrow when the announced time is
  within a window's reach, while genuinely stale banners still resolve
  due-now.
- Codex windows are labeled from `window_minutes` everywhere (300 → 5h,
  10080 → weekly, 43200 → 30d on the go plan) — stop records no longer
  conflate the monthly window with the weekly bucket.

## 1.12.2 — 2026-07-16

- **Daemon autostart self-heal**: updating via npm never touches the
  launchd/systemd unit file, so pre-1.12 users would keep the PATH-less unit
  (daemon can't find tmux → every revival dies) until they manually re-ran
  `unsnooze install --daemon`. The daemon now detects a PATH-less unit on
  startup, regenerates it, and reloads itself — every affected user is fixed
  automatically on their first daemon restart after updating (at the latest,
  the next reboot). Manual `unsnooze install --daemon` still works and is no
  longer required.

## 1.12.1 — 2026-07-16

- CI-only: pin the platform in a doctor test whose `launchctl` assertion
  failed on Linux runners. No runtime changes — this is 1.12.0 plus a green
  release pipeline (1.12.0 was tagged but never published).

## 1.12.0 — 2026-07-16

- **Daemon PATH fix** (fix: every launchd-daemon revival on Homebrew Macs died
  silently with `spawn tmux ENOENT` — launchd gives daemons a bare
  `/usr/bin:/bin:/usr/sbin:/sbin` and tmux lives in `/opt/homebrew/bin`): the
  launchd plist and systemd unit now bake the install-time `PATH`. Re-run
  `unsnooze install --daemon` once after updating to regenerate the unit.
  Revival `new-window` failures are now logged (they were silent), and
  `failed` records survive the sweeper so `unsnooze status` can show *why* a
  session gave up (age-based prune still expires them).
- **`unsnooze preview [id]`** — a true dry-run: per session, exactly what the
  resumer WOULD do right now (type into which pane, drive the menu, reopen in
  which session, probe, defer) and why — every gate (paused, not due, held by
  workspace/context guard, backoff, attempt cap) spelled out, including the
  final wake message with any guard suffix. Sends nothing, mutates nothing.
  Preview shares its decision code (`planFor`/`assessPane`/guard evaluators)
  with the real dispatcher, so it cannot drift. Exit codes: `0` nothing would
  wake now, `2` at least one actionable wake, `1` error.
- **ntfy push notifications** (`ntfyTopic` / `ntfyServer` / `ntfyToken` /
  `ntfyPrivacy`) — off until a topic is set; fires *alongside* the local
  channel on limit-hit / resumed / gave-up (gave-up pushes at high priority).
  JSON-to-root publishing (emoji-safe titles), Bearer-token support for authed
  or self-hosted servers, bodies capped, fire-and-forget with a 5s timeout.
  `ntfyPrivacy=terse` keeps directory paths out of pushed bodies — ntfy.sh
  topics are a public namespace, so the docs push unguessable topic names.
- **Trust & security docs**: a "Trust & security" section at the top of the
  README (what unsnooze types and never types, grounded in the actual
  mechanisms) and a full `SECURITY.md` (threat model, honest residual risks,
  private vulnerability reporting, supported versions). Enable GitHub Private
  Vulnerability Reporting in the repo settings to activate the report button.
- **Release provenance**: `.github/workflows/release.yml` publishes to npm on
  `v*` tags via trusted publishing (OIDC, token-less) with
  `--provenance` — after a one-time trusted-publisher setup on npmjs.com
  (repo `saaranshM/unsnooze`, workflow `release.yml`).
- **Reproducible demo**: `demo/demo.tape` (VHS) renders `assets/demo.gif` —
  staged fixture ledger + stub agent, but the `unsnooze status` beat is real.
- Note: the pre-release name `claude-session-guard` was never published to
  npm, so there is nothing to deprecate on the registry; `unsnooze doctor
  --fix` remains the migration path for local installs.

## 1.11.0 — 2026-07-16

- **`unsnooze doctor [--fix]`** — install health check + migration sweep for
  the pre-release claude-session-guard (csg) install. Detects zombie csg
  monitors/resumers, old launchd/systemd units, the orphaned
  `~/.claude-session-guard` state dir, and the stale global package (even when
  its `csg` bin symlink dangles). `--fix` stops the processes, unloads and
  removes the units, and archives the state dir (never deletes data, never
  runs npm — the `npm rm -g claude-session-guard` step stays yours).
  `unsnooze install` now runs the detection and points at doctor when
  leftovers exist.
- **Pane identity & ownership** (fix: tmux pane ids are server-global and
  recycled — a stale monitor or reap could type into or close somebody
  else's pane): managed panes are stamped with a `@unsnooze_owner` pane
  option at launch and revival; every message-injection, menu-drive, reap,
  and auto-reap decision now answers two independent questions first —
  *is this pane ours* (stamp/lease; a mismatched stamp vetoes even a
  matching foreground command) and *is our agent still running in it*
  (lease pid+birth or foreground command; the stamp alone never counts,
  since it outlives the agent and the pane may now be the user's shell).
  Monitors exit once their lease disappears instead of scraping whatever the
  pane becomes. Legacy records without leases are never force-closed.
- **Launch failures degrade instead of dying** (fix: a tmux-level
  session-start failure — `duplicate session`, `open terminal failed`, dead
  socket, nesting refusal, socket permission errors — used to exit with
  tmux's status and no agent): launchWrapped now reads tmux's stderr,
  distinguishes "session never started" from "session ran and ended", and
  falls back to the unwatched agent CLI with a message.
- **Zellij detection fix**: `capturePane` now dumps scrollback
  (`dump-screen --full`) — a limit banner that scrolled between polls was
  previously invisible on Zellij. Pre-0.35 zellij rejects the flag; capture
  learns that once and degrades to the viewport-only form instead of
  failing every poll.
- **Reset-time correctness**: weekly "resets Tuesday 9am" wakes land on the
  exact wall-clock time across DST boundaries (day-stepping used to drift
  ±1h); a mangled banner clock ("resets 45:99") is rejected instead of
  throwing; "wait <duration>" only parses when a duration actually follows
  (no more summing stray durations out of prose).
- **State safety**: sweepers use compare-and-set so `markStaleAbandoned` can
  no longer clobber a record that resumed mid-sweep; the state lock records
  its holder pid and is only ever stolen from a dead process; user-invoked
  `reap` skips `resumed` panes that were active within `reapIdleAfter`
  (closing a live working agent contradicted its own contract).
- **Install backups**: the first-ever run snapshots your pristine
  settings/rc as `.unsnooze-orig` (kept forever); `.unsnooze-bak` keeps
  rolling per run.

## 1.10.1 — 2026-07-16

- **Upgrade-window fail-safe** (fix: `npm install -g` briefly leaves `bin/`
  present with `src/` missing; the router then died with `MODULE_NOT_FOUND`
  *inside* the freshly-wrapped tmux session — a visible open/close flash with
  terminal-probe garbage — and the launchd daemon crash-looped thousands of
  times into `daemon.log`): agent-launch paths (`_run`, bare `claude` args)
  now degrade to the plain agent CLI when the package can't load; background
  paths (hook, monitor, resumer, daemon, update-check) exit 0 quietly. Only
  module *load* failures are caught — runtime errors still surface, and an
  agent that already ran is never re-run.
- **Daemon crash-loop guards**: launchd plist gains `ThrottleInterval 30`;
  the systemd unit moves to `Restart=always` + `RestartSec=30` (a clean
  exit-0 must also respawn — `on-failure` would leave the daemon dead after
  an intentional exit) with the start rate-limit disabled so a long broken
  install can never trip the unit into a permanent `failed` state. A
  version-skew watch makes a long-lived daemon exit cleanly (and get
  restarted on fresh code) when `npm -g` swaps the package underneath it —
  no more zombie daemons running deleted code.
- **Log rotation**: `unsnooze.log` and `daemon.log` are capped at 5 MB with
  one rotated generation (`.1`) — a crash-loop can no longer grow a log
  without bound. `daemon.log` is rotated copy-truncate style because launchd
  holds its fd open for the daemon's whole lifetime.
- **Resume-retry backoff** (fix: five resume attempts burned in ~2 minutes
  when a revival kept failing): failed attempts now back off exponentially
  (1m, 2m, 4m… capped at 30m). Manual `resume-now` records are exempt — an
  explicit immediate wake is never silently deferred. After `unsnooze` gives
  up, a session re-arms only on a fresh limit detection.
- **Singleton-lock hygiene**: the resumer lock is acquired atomically
  (`wx`), a lock held by a recycled pid that is not actually an unsnooze
  process is taken over instead of honored forever, and the daemon's
  "another resumer holds the lock" log line is throttled to ~once per 15
  minutes instead of every 30 s tick.
- **Update notice on the launch path**: wrapper-only users (who never run
  `unsnooze status`) now get the one-line "new version available" notice on
  stderr right after their agent session ends — outer terminal only, TTY
  only, never in `-p/--print` runs, at most once per day. The launch path
  also refreshes the daily version-check cache.

## 1.10.0 — 2026-07-14

- **Session-name ownership** (fix: interactive `claude` dying with
  `duplicate session: unsnooze`): the interactive launcher owns the base name
  `unsnooze` (and `unsnooze-2`… on collision); the resumer daemon may join a
  live session but only ever **creates** `unsnooze-resumed`. Records now
  discover the live mux session via `sessionForPane` instead of freezing the
  load-time `MUX_SESSION_NAME` constant. tmux `newWindow` returns
  `paneOwner: null` (pane ids are server-global). Uninstall stops the resumer.
  Failed session creation degrades to an unwatched agent CLI instead of
  bricking `claude`/`codex`. New: `unsnooze sessions`, `unsnooze reap
  [--dry-run|--yes]`; optional `reapResumed` / `reapIdleAfter`. Zellij revival
  uses `--close-on-exit` and closes the default shell pane left by
  `attach -b -c`. Env: `UNSNOOZE_SESSION_NAME`, `UNSNOOZE_RESUME_SESSION`.
- **Reset-time accuracy** (fix: blind `now + 5h` fallback and +24h rollover
  of already-past clock times): reset times are anchored to the banner's own
  timestamp (`bannerAt`), not the scrape moment. Claude stops prefer the dated
  transcript entry over an undated pane scrape. An absolute clock time already
  past relative to wall clock means the limit already reset (due now), not
  tomorrow. Compact durations like `1h 30m` sum all tokens. Unparseable banners
  probe cheaply (`PROBE_INTERVAL_MS`, backoff to `PROBE_MAX_MS`) instead of
  sleeping five hours; hard ceiling remains `FALLBACK_RESET_MS`. Monitor first
  tick requires corroboration; later ticks can upgrade a weak estimate.
  `unsnooze status` shows provenance (`absolute, from transcript` vs
  `guessed: no reset time found — probing`).
- **Upgrade-safe state migration** for existing installs: `tmuxSession` →
  `muxSession` (unchanged), bogus tmux `paneOwner` values cleared so leases
  match again, old blind `fallback` waits beyond the probe ladder are pulled
  into the first probe window (absolute/relative schedules untouched),
  `TMUX_SESSION_NAME` alias kept, `reapResumed` defaults off, new config keys
  only add defaults (existing `config.json` keeps working without edits).

## 1.9.0 — 2026-07-13

- **Context-size guard** (`contextGuard`: `off` | `inform` | `pause`, default
  `inform`; threshold `contextGuardTokens`, default `100000`): waking a
  session hours after a limit stop re-reads its entire context at full
  uncached price (the provider's prompt cache expires in minutes) — a
  150k-token session can eat a real slice of a fresh 5-hour window the moment
  it wakes. unsnooze now estimates the size from the session transcript (the
  last `message.usage` entry, tail-read) before dispatch: `inform` resumes
  and notifies you of the price once the wake lands; `pause` holds sessions
  at or above the threshold (`held: context ~152k tokens` in status) until
  `unsnooze resume-now`, which always bypasses the guard. The estimate also
  shows per-session in `unsnooze status` (`ctx ~152k tok`). Claude Code only
  for now — the agent-adapter hook (`contextTokens`) is open for Codex, whose
  rollout `token_count` events carry the same data. Prompted by r/ClaudeAI
  feedback on a resume consuming 30% of a 5h quota.

## 1.8.1 — 2026-07-13

- **Discovery / SEO**: package description and keywords expanded so npm and
  GitHub surface Qwen Code, Kimi CLI, OpenCode, Antigravity, OpenRouter, and
  Zellij alongside Claude/Codex/Grok. README comparison table updated to match.

## 1.8.0 — 2026-07-13

- **Notification channels** (`notifyChannel`: `auto` | `native` | `osc` |
  `bell`, env `UNSNOOZE_NOTIFY_CHANNEL`): terminal-branded alerts via OSC 9
  (iTerm2, kitty, WezTerm, Ghostty, Warp) or OSC 777 (rxvt), plus BEL on the
  pane tty. `auto` sends OSC+BEL when tmux can reach client/pane ttys and
  falls back to the OS toast only if OSC delivered nothing; denylisted
  terminals (Apple Terminal, VS Code, Alacritty, Zed) skip OSC in auto.
  OSC/BEL require tmux — Zellij and GUI-watcher stops use native. Existing
  `notifications` remains the master off-switch.
- **Unified ChatGPT desktop app support** (July 2026: the Codex app became the
  ChatGPT app). Verified against a real install: the app's bundled
  `codex app-server` still writes rollouts to `~/.codex/sessions/` in the same
  format (now with additive `limit_id`/`credits`/`plan_type` fields and
  reason-string `rate_limit_reached_type` values — both handled), and
  `codex resume <uuid>` works for app-originated sessions. New: when `codex`
  is not on PATH but ChatGPT.app is installed, unsnooze resolves the
  app-bundled binary (`ChatGPT.app/Contents/Resources/codex`) for wrappers,
  wizard detection, and revival. Rollouts older than 7 days are now
  zstd-compressed by codex; irrelevant for detection (freshness window is
  minutes) but noted for `unsnooze report` archaeology.
- Added a dual tmux/Zellij multiplexer backend. The new `multiplexer` setting
  accepts `auto`, `tmux`, or `zellij`; status output identifies the backend,
  qualified pane address, and revival session. Zellij revival uses structured
  pane ownership and a reserved-session smoke test without adding a statusline
  notification path.

## 1.7.0 — 2026-07-12

- **Four new agent adapters** (all ⚠️ experimental, off by default — enable in
  `unsnooze setup`):
  - **Qwen Code** (`qwen`): Claude-shaped `StopFailure` hook installed into
    `~/.qwen/settings.json` + verbatim quota-banner scraping (legacy OAuth,
    Coding Plan `Allocated quota exceeded` → 5h window, OpenRouter
    passthroughs). Resumes via `qwen --resume <id>`, ids from qwen's
    `*.runtime.json` sidecars.
  - **Kimi CLI** (`kimi`): detects the terminal red
    `Error code: 429 … rate_limit_reached_error` line; resumes via
    `kimi -r <id> -p "<msg>"` with an on-disk id check (kimi silently starts a
    NEW session for unknown ids). `Membership expired` is notify-only.
  - **OpenCode** (`opencode`): OpenCode self-retries limits forever (sleeping
    until reset), so unsnooze records the stop, never touches a live
    self-retrying pane, and revives dead panes mid-wait via
    `opencode -s <ses_id>` — reset time parsed from the
    `[retrying in 2h5m attempt #N]` countdown.
  - **Antigravity CLI** (`agy`, Google's Gemini-CLI successor): scrapes
    `Model quota limit exceeded` / `Refreshes in 6 days and 18 hours`
    (multi-day refresh = weekly cap); `503 MODEL_CAPACITY_EXHAUSTED` is treated
    as transient overload. Resumes via `agy --conversation=<id>`.
- **OpenRouter awareness**: 429 bodies (`Rate limit exceeded: limit_…`,
  free-models-per-day) are detected inside OpenCode/Qwen sessions; credit
  exhaustion (402) notifies instead of snoozing.
- **Terminal-error channel**: non-resetting errors (credits exhausted,
  membership expired, discontinued tiers) now raise a single desktop
  notification instead of being retried against a reset that will never come.
- **time-parser**: understands `Refreshes in 6 days and 18 hours`,
  `It will reset in 2 hours 5 minutes`, `Retry in 45 minutes`, and Go-style
  countdowns (`2h5m`, `2m 5s`, `~2 days`).

## 1.6.0 — 2026-07-12

- **Stale-workspace guard** (`workspaceGuard`: `off` | `inform` | `pause`,
  default `inform`): the repo's HEAD + dirty state are fingerprinted when a
  session stops and re-checked at wake. `inform` resumes with a "workspace
  changed while you slept — re-read before acting" note in the wake message;
  `pause` holds the session (desktop notification, `workspace changed` marker
  in status) until `unsnooze resume-now`, which prints the diff stat first.
  Non-git directories are unaffected. Suggested by r/codex feedback.

## 1.5.0 — 2026-07-12

- **`unsnooze update`**: one command to update unsnooze itself — runs
  `npm install -g unsnooze@latest` and immediately prints the new version's
  changelog. Update notices and the daemon toast now say `run: unsnooze
  update` instead of the raw npm command.

## 1.4.0 — 2026-07-12

- **Update notices**: unsnooze now checks the npm registry (at most once a
  day, a plain GET with nothing identifying) and tells you when a new version
  is out — a one-line notice after CLI commands, and a single desktop toast
  per version from the daemon. After you update, the next command shows a
  short "what's new" straight from the bundled changelog. Turn it all off
  with `unsnooze config set updateCheck off`.

## 1.3.0 — 2026-07-11

- **Per-session wake messages**: `unsnooze message <id|--all> "<text>"` sets a
  custom resume message for specific tracked sessions (`--clear` reverts).
  Precedence: per-session → per-agent (`resumeMessages.<id>`) → global
  `resumeMessage`. Applies on both wake paths — typed into a live pane, or
  carried in argv for `codex resume` — and sessions with a custom message
  show a `msg: "…"` marker in `unsnooze status`.

## 1.2.0 — 2026-07-10

### GUI surfaces: VS Code extension, desktop apps

Sessions running outside a terminal — Claude Code's VS Code extension and
desktop app, Codex's IDE extension and desktop app — are now guarded too.
There is no pane to scrape and (for Codex) no hook, so detection tails the
session files the CLIs already write:

- **Claude Code**: rate-limit stops land in `~/.claude/projects` transcripts
  as structured entries (`error:"rate_limit"`, session id, cwd, reset text).
  The new watcher turns them into ledger records; the weekly banner form
  ("resets Jul 4 at 12:30am (tz)") now parses, DST-safe.
- **Codex**: rollouts never persist error events, but every turn's
  `token_count` event carries a `rate_limits` snapshot (`used_percent`,
  `resets_at` epoch). An exhausted window becomes a stop with an exact epoch
  reset — more precise than any scraped banner — and works for every Codex
  surface, since they share `~/.codex/sessions`.
- **Claude desktop (cowork) sessions** *(experimental, macOS)*: sandboxed
  sessions under `~/Library/Application Support/Claude` are detected, and
  revival exports the session's isolated `CLAUDE_CONFIG_DIR` together with
  `CLAUDE_SECURESTORAGE_CONFIG_DIR=''` so auth resolves through the default
  keychain entry (the sandbox holds no credentials). Verified end-to-end
  against a real desktop session.

Revival stays terminal-based: when the limit resets, the session reopens in a
tmux window via `claude --resume <id>` / `codex resume <id>` — the same
session file continues, so the conversation stays visible in the GUI's own
history. Resuming *inside* the GUI panels is not possible today (no IPC/URI
sends a prompt into them).

- **`unsnooze daemon`**: persistent watcher process; `unsnooze install
  --daemon` (or the new wizard step) installs it as a launchd agent (macOS)
  or systemd user unit (Linux) so GUI sessions are watched without a shell.
- **`guiWatch` setting** (default on) gates the watching; `unsnooze status`
  shows each stop's origin (`cli`, `vscode`, `desktop`, …).
- Ledger dedupe: transcript records merge with hook/scrape records of the
  same session, so terminal sessions are never double-resumed.

## 1.1.0 — 2026-07-10

### Per-agent resume messages

- **`resumeMessages.claude` / `.codex` / `.grok`**: optional per-agent override
  of the global `resumeMessage` — `unsnooze config set resumeMessages.codex
  "..."` or `UNSNOOZE_RESUME_MESSAGE_CODEX`. Empty means "use the global
  message"; clear with `unsnooze config set resumeMessages.codex ""`.
  Specificity beats source: a per-agent file value outranks a global env var.
- **Setup wizard** asks for per-agent messages, prefills every message prompt
  from the existing config, and merges over the config file — re-runs no
  longer clobber values set via `unsnooze config`.
- Blank or whitespace-only messages are never sent: resolution falls through
  to the global message, then the built-in default.

### CLI & fixes

- **`-h` / `--help`** now print the unsnooze help (previously only
  `unsnooze help`), and the usage documents every command.
- **Install**: `unsnooze setup` / `install` no longer crashes with ENOENT on
  machines without a `~/.claude/` directory.
- `unsnooze config set <key> ""` is a valid way to clear string overrides, and
  a config file holding non-object JSON is treated as empty instead of
  corrupting later writes.

## 1.0.0 — 2026-07-10

First public release (previously the private `claude-session-guard`/`csg`).

### Multi-CLI auto-resume

- **Claude Code and OpenAI Codex CLI fully supported; xAI Grok Build
  experimental** (generic patterns + `unsnooze report` to contribute real
  banner captures).
- **Agent adapters** (`src/agents/`): per-CLI banner regexes, busy/idle
  markers, resume invocation, session-store lookup, hook wiring.
- **Codex specifics**: verbatim banner strings from the Codex source; parses
  `try again at 3:51 PM`, `Feb 23rd, 2026 9:01 PM`, and
  `in 4 days 20 hours 9 minutes`; dead sessions revive via
  `codex resume <id> "<message>"` — the prompt travels in argv, nothing is
  typed into the pane.

### Settings & UX

- **Settings**: `~/.unsnooze/config.json`, `unsnooze config list/get/set`,
  toggles for autoResume, menuAutoAnswer, notifications, resumeMessage, and
  per-agent enablement (env > file > default).
- **Setup wizard**: `unsnooze setup` — detects installed CLIs, warns when
  `grok` is the community CLI rather than Grok Build, installs wrappers
  (zsh + bash) and hooks.
- **Desktop notifications** on limit detected / session resumed / gave up
  (macOS osascript, Linux notify-send, tmux fallback).

### Windows / WSL

- **Windows via WSL**: native Windows toast notifications from inside WSL via
  `powershell.exe` (no notify-send/X server needed), `where`-based CLI
  detection, and a friendly "install tmux / use WSL" message instead of a
  hard failure when tmux is missing (the agent CLI still runs, just
  unwatched). The tmux-independent core is exercised on Windows in CI.

### Safety hardening

- **Wrappers and hooks can never brick the wrapped CLI**: the shell wrapper
  falls through to the real `claude`/`codex`/`grok` when the unsnooze entry
  point is missing, and hook commands no-op (`exit 0`) instead of erroring on
  every turn.
- **Menus are answered from the visible screen only**, never from tmux
  scrollback — an already-answered menu in history can no longer trigger
  stray keystrokes (relevant for non-alt-screen TUIs like
  `codex --no-alt-screen`).
- **Session reopen uses absolute node + entry-point paths** instead of a PATH
  lookup — a tmux server started without npm globals (or nvm's node) on PATH
  can no longer break revival with command-not-found.
- Migrates cleanly off `claude-auto-retry` and the pre-release csg install
  (fenced rc blocks and settings.json hook entries are replaced, with
  backups).

### Testing

- 104 unit tests plus a **12-scenario end-to-end suite**
  (`scripts/e2e-simulate.sh`) that exercises every agent and safety path in
  real tmux with real monitor/hook/resumer processes — banner detection for
  all three CLIs, raw-key menu driving with selection verification, hook
  ingestion, dead-pane and live-pane resume, both toggles, and the
  529-overload retry ladder (now env-tunable via
  `UNSNOOZE_OVERLOAD_BACKOFF_S`).
- CI: Ubuntu + macOS (Node 20/22) and Windows (Node 22).
