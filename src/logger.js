import { appendFileSync, mkdirSync, statSync, renameSync, copyFileSync, truncateSync } from 'node:fs';
import { dirname } from 'node:path';
import { LOG_FILE } from './config.js';

// Logs must never grow unbounded (a single upgrade-window crash-loop once
// produced a 10.3 MB daemon.log). One rotated generation is kept: file → .1.
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

let dirReady = false;

/**
 * Rename `path` to `path.1` when it exceeds maxBytes (replacing any previous
 * .1). Returns true when a rotation happened. Missing files and fs errors are
 * a quiet no-op — rotation must never crash the hook or monitor paths.
 */
export function rotateIfLarge(path, maxBytes = LOG_MAX_BYTES) {
  try {
    if (statSync(path).size <= maxBytes) return false;
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy-truncate variant for files another process holds OPEN (launchd's
 * StandardOut/ErrorPath fd on daemon.log): renaming such a file would leave
 * the holder writing to the renamed inode forever, with no fresh file until
 * its next restart. Copying to .1 and truncating in place keeps the inode —
 * the holder's O_APPEND writes continue into the now-empty live file.
 * Same quiet-no-op error contract as rotateIfLarge.
 */
export function copyTruncateIfLarge(path, maxBytes = LOG_MAX_BYTES) {
  try {
    if (statSync(path).size <= maxBytes) return false;
    copyFileSync(path, `${path}.1`);
    truncateSync(path, 0);
    return true;
  } catch {
    return false;
  }
}

export function log(component, message) {
  const line = `${new Date().toISOString()} [${component}] ${message}\n`;
  try {
    if (!dirReady) {
      mkdirSync(dirname(LOG_FILE), { recursive: true });
      dirReady = true;
    }
    rotateIfLarge(LOG_FILE);
    appendFileSync(LOG_FILE, line);
  } catch {
    // Logging must never crash the hook or monitor paths.
  }
  if (process.env.UNSNOOZE_DEBUG) process.stderr.write(line);
}

export function makeLogger(component) {
  return (message) => log(component, message);
}
