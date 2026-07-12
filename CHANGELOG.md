# Changelog

## Unreleased

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
