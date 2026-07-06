# claude-session-guard (`csg`)

Detects when Claude Code CLI sessions hit a usage limit (5-hour or weekly),
tracks **every** stopped session across all your projects, and **re-opens each
one interactively in tmux** the moment the limit refreshes — so long-running
work continues without you babysitting the terminal.

Replaces [claude-auto-retry] with a multi-session design: auto-retry only
watched the one pane it launched; csg keeps a shared ledger of all limit-stopped
sessions and a single resumer daemon that revives them all.

## How it works

```
claude (via zsh wrapper) ──► csg launcher ──► claude in tmux pane
                                   │
                                   ├─ per-pane monitor (scrapes for limit banners,
                                   │  drives the /rate-limit-options menu,
                                   │  seconds-scale retry on 5xx/overload)
                                   │
StopFailure hook (rate_limit) ─────┤
                                   ▼
                     ~/.claude-session-guard/state.json
                     { sessionId, cwd, pane, resetAt, status }
                                   │
                                   ▼
                     resumer daemon (singleton, epoch-polling —
                     survives laptop sleep and weekly-scale waits)
                                   │
                 ┌─────────────────┴──────────────────┐
        pane still alive?                     pane gone?
        send "continue" into it               tmux new-window in session 'csg',
        (only if claude is foreground         `csg --resume <sessionId>`, wait
        and not mid-stream)                   for ready, send resume message
```

Detection is dual-channel: the Claude Code `StopFailure` hook (authoritative,
carries `session_id`/`cwd`) plus tmux pane scraping (catches banners the hook
misses, and the interactive "What do you want to do?" limit menu — always
answered with "Stop and wait for limit to reset", never a blind Enter).

Limit events are never persisted by Claude Code itself; the reset time is
parsed from the banner text ("resets 3pm (UTC)", "try again in 2 hours",
"resets Tuesday 9am"), DST-safe, with a 5-hour fallback when unparseable.

## Install

```sh
cd claude-session-guard
npm install -g .        # provides `csg`
csg install --yes       # wires the zsh claude() wrapper + StopFailure hook,
                        # removing claude-auto-retry's versions (backups kept)
npm uninstall -g claude-auto-retry
exec zsh
```

`csg install` edits `~/.claude/settings.json` (JSON-merged, backed up to
`settings.json.csg-bak`) and appends a fence-marked block to `~/.zshrc`
(backed up to `.zshrc.csg-bak`). `--settings <path>` / `--zshrc <path>`
override the targets (used by tests).

## Usage

```sh
claude                       # normal usage — wrapped automatically
csg status                   # tracked sessions + reset countdowns
csg resume-now [id|--all]    # don't wait for the reset time
csg cancel [id|--all]        # stop tracking a session
csg logs [-f]                # what csg has been doing
csg uninstall [--purge]      # remove wrapper + hook (+ state with --purge)
```

Everything lives in `~/.claude-session-guard/` (state, logs, locks). All
timings/paths are overridable via `CSG_*` env vars — see `src/config.js`.

## Safety properties

- **Never injects blind**: keys are only sent when the pane's foreground
  process is claude and no "esc to interrupt" / internal-retry footer is
  visible. Recycled pane ids can't receive stray messages.
- **Never picks a menu option blind**: if the limit menu layout can't be read,
  csg does not press Enter (that could confirm "Upgrade your plan").
- **Sleep-safe waits**: the resumer polls wall-clock against the target epoch
  every 30s instead of one long timer — a laptop asleep past the reset fires
  on the next tick. Weekly limits are just a bigger epoch.
- **Verified resumes**: after dispatch it re-captures the pane; if the limit
  banner reappears (reset time misparsed / not actually reset), it reschedules
  from the fresh banner, capped at 5 attempts.
- **Concurrent-writer safe**: state updates go through a mkdir lock + atomic
  rename; corrupt state is quarantined, never fatal (the hook path must never
  block claude).
- **Overload ≠ limit**: 5xx/529/429 transient errors take a seconds-scale
  backoff path ([30,60,120,240,300]s ± jitter) and never enter the ledger.

## Development

```sh
npm test                     # 47 unit tests (node:test)
./scripts/e2e-simulate.sh    # full detect → wait → re-open cycle in a
                             # scratch tmux session (no real limits needed)
```

[claude-auto-retry]: https://www.npmjs.com/package/claude-auto-retry
