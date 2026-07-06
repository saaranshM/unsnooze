# claude-session-guard — design

**Date:** 2026-07-05 · **Status:** approved (plan mode) and implemented

## Problem

Claude Code CLI sessions stop when a usage limit (5-hour or weekly) is hit.
The limit event is shown only in the TUI — it is not persisted to transcripts,
settings, or any file — so nothing can resume the work automatically once the
limit refreshes. The previously installed `claude-auto-retry` npm package only
guards the single live pane it launched. The user wants: detect the limit
refresh and **continue all tasks stopped by the limit**, re-opened
**interactively in tmux**, implemented as their **own Node.js tool replacing
claude-auto-retry**.

## Decisions (made during brainstorming)

1. **Replace claude-auto-retry** entirely (uninstall it; own the code).
2. **Interactive re-open** in tmux at refresh time — not headless `-p` resume,
   not notify-only.
3. **Node.js**, plain ESM, zero dependencies.

## Architecture

Five cooperating pieces around one shared ledger
(`~/.claude-session-guard/state.json`):

| Piece | Trigger | Job |
|---|---|---|
| launcher (`csg [args]`) | user runs `claude` (zsh wrapper) | ensure tmux, spawn detached per-pane monitor, run claude, pass through exit code |
| monitor (`csg _monitor <pane>`) | launcher | scrape pane every 5s: record limit banners, drive the `/rate-limit-options` menu to "Stop and wait", seconds-scale overload retries, flip records to `resumed` when the banner clears |
| hook (`csg _hook-stopfailure`) | Claude Code `StopFailure` hook (matcher `overloaded\|server_error\|rate_limit`) | authoritative detection channel: carries `session_id`/`cwd`; rate_limit → ledger record; overload → per-pane event marker |
| resumer (`csg _resumer`) | spawned on any ledger write | singleton daemon; polls wall-clock vs earliest `resetAt` (+60s margin) every 30s; at refresh, per record: live claude pane → send continue; dead pane → `tmux new-window -c <cwd>` running `csg --resume <sessionId>`, wait ready, send resume message; verify after 20s (banner back → reschedule, attempts capped at 5); exits when nothing pending |
| CLI (`csg status/resume-now/cancel/logs/install/uninstall`) | user | visibility + control + migration |

### State record

```json
{ "sessionId": "uuid|null", "cwd": "...", "pane": "%12", "tmuxSession": "csg",
  "status": "stopped|resuming|resumed|failed|cancelled",
  "limitType": "5h|weekly|unknown", "detectedVia": "hook|scrape|menu",
  "detectedAt": 0, "resetAt": 0, "resetSource": "absolute|relative|fallback",
  "attempts": 0, "lastAttemptAt": null, "lastError": null }
```

Keyed by `sessionId` (hook) or `pane:<id>:<ts>` (scrape, sessionId backfilled
from newest transcript mtime in `~/.claude/projects/<dashed-cwd>/`). Hook and
scrape detections of the same event dedupe on pane within a 2-minute window.

### Key invariants

- Reset waits are **epoch polls, never long timers** — survives sleep; weekly
  limits are the same loop with a bigger target.
- Key injection requires pane alive + claude foreground + not busy
  ("esc to interrupt" / "Retrying in" absent). A pane showing a shell is
  re-opened in a new window, never hijacked.
- The limit menu is navigated by locating the cursor and the "Stop and wait"
  option; unreadable layout → no Enter ever.
- Ledger writes are mkdir-locked + tmp/rename atomic; corrupt state is
  quarantined; the hook path always exits 0 fast.
- Pane text tails operate on **content lines** (trailing blank pane rows
  stripped) — found via e2e: a banner at the top of a fresh pane sat entirely
  above a naive last-12-screen-rows window.
- Overload (5xx/529/429) is a separate seconds-scale backoff path
  ([30,60,120,240,300]s ± 15% jitter) that never enters the ledger.

## Migration

`csg install --yes` replaces claude-auto-retry's `StopFailure` hook entry in
`~/.claude/settings.json` (JSON-merge, backup) and its fenced zshrc `claude()`
wrapper (backup), then the user runs `npm uninstall -g claude-auto-retry`.
`csg uninstall [--purge]` reverses.

## Verification

- 47 unit tests (`node --test`): patterns (incl. ANSI, scrollback, blank-pad
  regressions), DST/weekly time parsing, state lock race (10 writers × 5),
  monitor fixture ticks, resumer dispatch/verify decisions, installer merges.
- `scripts/e2e-simulate.sh`: real tmux, fake banner → monitor records with
  parsed reset → record forced due → resumer re-opens a stub claude in a new
  window and the resume message arrives; record ends `resumed`.
- Hook smoke: fixture JSON on stdin → correct ledger record in 52ms, exit 0.
