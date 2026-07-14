import { homedir } from 'node:os';
import { join } from 'node:path';

function envInt(name, def) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}

export const STATE_DIR = process.env.UNSNOOZE_STATE_DIR || join(homedir(), '.unsnooze');
export const STATE_FILE = join(STATE_DIR, 'state.json');
export const LOCK_DIR = join(STATE_DIR, 'state.lock');
export const LOG_FILE = join(STATE_DIR, 'unsnooze.log');
export const EVENTS_DIR = join(STATE_DIR, 'events');
export const RESUMER_LOCK = join(STATE_DIR, 'resumer.lock');

export const CLAUDE_DIR = process.env.UNSNOOZE_CLAUDE_DIR || join(homedir(), '.claude');
export const CLAUDE_SETTINGS = join(CLAUDE_DIR, 'settings.json');
export const CODEX_DIR = process.env.UNSNOOZE_CODEX_DIR || join(homedir(), '.codex');

// Transcript/rollout watcher (GUI detection channel)
export const WATCH_OFFSETS_FILE = join(STATE_DIR, 'watch-offsets.json');

// Interactive launcher base session name. The daemon never CREATES this name
// (see RESUME_SESSION_NAME); it may only join it when already live.
export const MUX_SESSION_NAME = process.env.UNSNOOZE_SESSION_NAME
  || process.env.UNSNOOZE_TMUX_SESSION || 'unsnooze';
// Legacy alias — older docs/scripts and any external importers used this name.
export const TMUX_SESSION_NAME = MUX_SESSION_NAME;

// Session the daemon creates for revivals when the pane's original session is
// gone. Must never collide with the interactive base name.
export const RESUME_SESSION_NAME = process.env.UNSNOOZE_RESUME_SESSION
  || `${MUX_SESSION_NAME}-resumed`;

// Timing (ms unless noted)
export const RESET_MARGIN_MS = envInt('UNSNOOZE_RESET_MARGIN_MS', 60_000);
export const POLL_INTERVAL_MS = envInt('UNSNOOZE_POLL_INTERVAL_MS', 30_000);       // resumer epoch polling
export const SCRAPE_INTERVAL_MS = envInt('UNSNOOZE_SCRAPE_INTERVAL_MS', 5_000);    // monitor pane scraping
export const FALLBACK_RESET_MS = envInt('UNSNOOZE_FALLBACK_RESET_MS', 5 * 3_600_000);
// When no reset time parses: cheap pane probes instead of sleeping for 5h.
// Backoff 15 → 30 → 60 min (capped at PROBE_MAX_MS); hard ceiling remains
// FALLBACK_RESET_MS from detectedAt.
export const PROBE_INTERVAL_MS = envInt('UNSNOOZE_PROBE_INTERVAL_MS', 15 * 60_000);
export const PROBE_MAX_MS = envInt('UNSNOOZE_PROBE_MAX_MS', 60 * 60_000);
export const STAGGER_MS = envInt('UNSNOOZE_STAGGER_MS', 8_000);
export const VERIFY_DELAY_MS = envInt('UNSNOOZE_VERIFY_DELAY_MS', 20_000);
export const BUSY_DEFER_MS = envInt('UNSNOOZE_BUSY_DEFER_MS', 60_000);
export const READY_TIMEOUT_MS = envInt('UNSNOOZE_READY_TIMEOUT_MS', 60_000);
export const EVENT_MARKER_TTL_MS = envInt('UNSNOOZE_EVENT_MARKER_TTL_MS', 120_000);
export const WATCH_FRESHNESS_MS = envInt('UNSNOOZE_WATCH_FRESHNESS_MS', 15 * 60_000);

// Pane scanning
export const PANE_SCAN_LINES = envInt('UNSNOOZE_PANE_SCAN_LINES', 12);
export const CAPTURE_LINES = envInt('UNSNOOZE_CAPTURE_LINES', 200);

// Limits & retries
export const MAX_RESUME_ATTEMPTS = envInt('UNSNOOZE_MAX_RESUME_ATTEMPTS', 5);
export const MAX_BUSY_DEFERS = envInt('UNSNOOZE_MAX_BUSY_DEFERS', 10);
export const OVERLOAD_BACKOFF_S = (process.env.UNSNOOZE_OVERLOAD_BACKOFF_S || '30,60,120,240,300')
  .split(',').map(Number).filter(Number.isFinite);
export const OVERLOAD_JITTER = 0.15;
export const DEDUPE_WINDOW_MS = envInt('UNSNOOZE_DEDUPE_WINDOW_MS', 120_000);
export const PRUNE_AFTER_MS = envInt('UNSNOOZE_PRUNE_AFTER_MS', 7 * 86_400_000);
// Non-terminal records with a dead/absent pane older than this are marked
// failed instead of being revived forever (ghost-pane multiplier).
export const STALE_AFTER_MS = envInt('UNSNOOZE_STALE_AFTER_MS', 7 * 86_400_000);
export const STALE_LOCK_MS = envInt('UNSNOOZE_STALE_LOCK_MS', 10_000);
