// Where a bare command name would be found: the first PATH entry holding one
// of `names`, as {dir, name, path}, or null. Path rules follow the platform
// being resolved for, not the host: on Windows the delimiter is ';' and every
// absolute entry contains a ':' (C:\...), so a ':' split shreds the list into
// nonsense and always answers "not on PATH" there (#25).

import { existsSync } from 'node:fs';
import { win32, posix } from 'node:path';

export function findOnPath(names, { env = process.env, exists = existsSync, platform = process.platform } = {}) {
  const api = platform === 'win32' ? win32 : posix;
  for (const dir of (env.PATH || '').split(api.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const path = api.join(dir, name);
      try { if (exists(path)) return { dir, name, path }; } catch { /* unreadable entry */ }
    }
  }
  return null;
}

// The spellings a bare name can take on this platform, launchable first.
// Node's spawn resolves .exe/.com itself; .cmd/.bat need a shell it is not
// given, so they are "found" in the sense that explains a failure.
export function candidateNames(name, platform = process.platform) {
  if (platform !== 'win32') return [name];
  if (/\.(exe|com|cmd|bat)$/i.test(name)) return [name];
  return [`${name}.exe`, `${name}.com`, `${name}.cmd`, `${name}.bat`];
}

// Resolve what spawn(bin) would actually run: an absolute or relative path is
// checked as-is; a bare name is searched on PATH. Returns
// { path, launchable } or null when nothing is found.
export function resolveBin(bin, { env = process.env, exists = existsSync, platform = process.platform } = {}) {
  if (typeof bin !== 'string' || bin === '') return null;
  const shim = p => /\.(cmd|bat)$/i.test(p);
  // Anything with a separator of either flavour is a path, checked as given —
  // spawn does the same, and a Windows-shaped path handed to a POSIX lookup
  // (doctor's own tests simulate one platform on another) must not be
  // searched on PATH as if it were a bare name.
  if (win32.isAbsolute(bin) || posix.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    return exists(bin) ? { path: bin, launchable: !shim(bin) } : null;
  }
  const hit = findOnPath(candidateNames(bin, platform), { env, exists, platform });
  return hit ? { path: hit.path, launchable: !shim(hit.path) } : null;
}
