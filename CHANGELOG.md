# Changelog

## 1.0.0 — 2026-07-10

- **Windows via WSL**: first-class support — native Windows toast
  notifications from inside WSL via `powershell.exe` (no notify-send/X server
  needed), `where`-based CLI detection, and a friendly "install tmux / use
  WSL" message instead of a hard failure when tmux is missing (the agent CLI
  still runs, just unwatched). Native win32 core is exercised in CI.

First public release (previously the private `claude-session-guard`/`csg`).

- **Multi-CLI**: Claude Code and OpenAI Codex CLI fully supported; xAI Grok
  Build experimental (generic patterns + `unsnooze report` to contribute real
  banner captures).
- **Agent adapters** (`src/agents/`): per-CLI banner regexes, busy/idle
  markers, resume invocation, session-store lookup, hook wiring.
- **Codex specifics**: verbatim banner strings from the Codex source; parses
  `try again at 3:51 PM`, `Feb 23rd, 2026 9:01 PM`, and
  `in 4 days 20 hours 9 minutes`; dead sessions revive via
  `codex resume <id> "<message>"`.
- **Settings**: `~/.unsnooze/config.json`, `unsnooze config list/get/set`,
  toggles for autoResume, menuAutoAnswer, notifications, resumeMessage, and
  per-agent enablement (env > file > default).
- **Setup wizard**: `unsnooze setup` — detects installed CLIs, warns when
  `grok` is the community CLI rather than Grok Build, installs wrappers
  (zsh + bash) and hooks.
- **Desktop notifications** on limit detected / session resumed / gave up
  (macOS osascript, Linux notify-send, tmux fallback).
- Migrates cleanly off `claude-auto-retry` and the pre-release csg install
  (fenced rc blocks and settings.json hook entries are replaced, with backups).
