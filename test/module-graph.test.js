// Every entry point must survive being the FIRST module in the graph.
//
// settings.js and multiplexer.js import each other: multiplexer.js needs
// getConfig, settings.js needs the backend-name list. If that list is declared
// in either module instead of a leaf, whichever one is reached first evaluates
// the other while it is still initialising, and the shared binding is read in
// its temporal dead zone. `unsnooze` itself survives that (cli.js reaches
// settings.js first) — the detached monitor does not, and a monitor that dies
// at import turns every wrapped launch into an unwatched one, silently.
//
// Each module is imported in its own process, because module evaluation is
// cached per process and the failure only reproduces on a cold graph.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src');

// Anything that is an entry point (bin, detached child, hook) or is imported
// first by one.
const ENTRY_POINTS = ['config.js', 'settings.js', 'multiplexer.js', 'monitor.js',
  'launcher.js', 'resumer.js', 'reap.js', 'hook.js', 'cli.js'];

for (const entry of ENTRY_POINTS) {
  test(`src/${entry} imports cleanly as the first module in the graph`, () => {
    // A file URL, not a path: `import("C:\\…")` is not a valid specifier on
    // Windows, and this test would fail there for that reason alone.
    const target = JSON.stringify(pathToFileURL(join(SRC, entry)).href);
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ['-e', `import(${target}).catch(e => { console.error(e.message); process.exit(1); })`],
        { stdio: 'pipe', encoding: 'utf8' });
    }, `importing src/${entry} first must not throw — a cycle through the backend-name list puts a shared binding in its TDZ`);
  });
}
