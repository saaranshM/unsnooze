// Where the fish shell looks for its config.
//
// A leaf module (node builtins only) on purpose — the same reason
// powershell.js exists: install.js already imports doctor.js, and doctor.js
// needs this to answer "are the wrappers installed?" for fish users.
// Declaring it in install.js would close that loop (see
// test/module-graph.test.js for what that breaks).
//
// fish reads its config from <config-home>/fish/config.fish, where
// <config-home> honors XDG_CONFIG_HOME (absolute paths only — the XDG spec
// says a relative value must be ignored, and fish follows that).

import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

export function fishConfigPath({ env = process.env, home = homedir() } = {}) {
  // Test/CI override, matching UNSNOOZE_QWEN_DIR and the autostart dir vars.
  if (env.UNSNOOZE_FISH_CONFIG) return env.UNSNOOZE_FISH_CONFIG;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, 'fish', 'config.fish');
  return join(home, '.config', 'fish', 'config.fish');
}
