# Changelog

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
