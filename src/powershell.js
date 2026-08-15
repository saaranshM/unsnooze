// Where PowerShell will actually look for a profile.
//
// A leaf module (node builtins only) on purpose: install.js already imports
// doctor.js, and doctor.js needs this to answer "are the wrappers installed?"
// on native Windows. Declaring it in install.js would close that loop, which is
// the same trap MUX_NAMES lives in config.js to avoid — see the comment there
// and test/module-graph.test.js, which spawns a fresh import per entry point to
// catch exactly this.
//
// Deliberately asked of PowerShell rather than derived: ~/Documents is
// routinely redirected into OneDrive, and PowerShell 7 (Documents/PowerShell)
// and Windows PowerShell 5.1 (Documents/WindowsPowerShell) disagree about the
// folder. A guessed path produces a wrapper that loads for nobody, which from
// the outside is indistinguishable from unsnooze silently not working.

import { spawnSync } from 'node:child_process';

function defaultPowershellRunner(file, args) {
  const r = spawnSync(file, args, { encoding: 'utf-8' });
  if (r.error || r.status !== 0) throw r.error || new Error(`${file} exited ${r.status}`);
  return r.stdout;
}

export function powershellProfilePath({
  platform = process.platform,
  runner = defaultPowershellRunner,
} = {}) {
  if (platform !== 'win32') return null;
  // pwsh first: if the user has PowerShell 7, that is the shell they are in.
  for (const exe of ['pwsh', 'powershell.exe']) {
    try {
      const out = runner(exe, ['-NoProfile', '-NonInteractive', '-Command',
        '$PROFILE.CurrentUserAllHosts']);
      const path = String(out ?? '').trim();
      if (path) return path;
    } catch (err) {
      // "PowerShell isn't installed" is the expected failure and moves on. A
      // ReferenceError/TypeError is a bug in this file, and swallowing it here
      // would look identical from the outside — an install that quietly never
      // writes a wrapper — so let it out.
      if (err instanceof ReferenceError || err instanceof TypeError) throw err;
    }
  }
  return null;
}
