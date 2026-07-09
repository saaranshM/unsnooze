import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LOG_FILE } from './config.js';

let dirReady = false;

export function log(component, message) {
  const line = `${new Date().toISOString()} [${component}] ${message}\n`;
  try {
    if (!dirReady) {
      mkdirSync(dirname(LOG_FILE), { recursive: true });
      dirReady = true;
    }
    appendFileSync(LOG_FILE, line);
  } catch {
    // Logging must never crash the hook or monitor paths.
  }
  if (process.env.UNSNOOZE_DEBUG) process.stderr.write(line);
}

export function makeLogger(component) {
  return (message) => log(component, message);
}
