// `unsnooze setup` — first-run interactive wizard (also invoked by a bare
// `unsnooze install` in a TTY with no saved config). Detects installed agent
// CLIs, asks for toggles, writes config.json, then wires wrappers + hooks.

import { execFileSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { listAgents } from './agents/index.js';
import { isCommunityGrokCli } from './agents/grok.js';
import { DEFAULTS, writeConfig, readFileConfig } from './settings.js';
import { logoLine } from './tui.js';

export function detectInstalledAgents({ which = defaultWhich } = {}) {
  return listAgents().map(agent => ({ agent, installed: which(agent.bin) }));
}

function defaultWhich(bin) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export async function runWizard() {
  p.intro(logoLine('setup') + ' — wake every limit-stopped AI coding session automatically');

  const { getMultiplexer } = await import('./multiplexer.js');
  const mux = getMultiplexer();
  if (!mux.available()) {
    p.log.warn(process.platform === 'win32'
      ? 'No supported multiplexer found — unsnooze does not support native Windows.\nRun it inside WSL.'
      : `${mux.name} not found — install it, then re-run \`unsnooze setup\`.`);
  }

  const detected = detectInstalledAgents();
  const options = detected.map(({ agent, installed }) => ({
    value: agent.id,
    label: agent.name + (agent.experimental ? ' (experimental)' : ''),
    hint: installed ? 'detected' : 'not found in PATH',
  }));

  const agents = await p.multiselect({
    message: 'Which CLIs should unsnooze guard?',
    options,
    initialValues: detected.filter(d => d.installed && !d.agent.experimental).map(d => d.agent.id),
    required: true,
  });
  if (p.isCancel(agents)) return cancelled();

  if (agents.includes('grok') && isCommunityGrokCli()) {
    p.log.warn('Your `grok` looks like the community superagent-ai/grok-cli, not xAI\'s Grok Build.\n'
      + 'unsnooze targets Grok Build; detection may not work on the community CLI.');
  }

  const autoResume = await p.confirm({
    message: 'Auto-resume sessions when the limit resets? (off = track only, resume manually)',
    initialValue: DEFAULTS.autoResume,
  });
  if (p.isCancel(autoResume)) return cancelled();

  const menuAutoAnswer = await p.confirm({
    message: 'Allowed to answer Claude\'s limit menu for you? (always picks "Stop and wait", never "Upgrade")',
    initialValue: DEFAULTS.menuAutoAnswer,
  });
  if (p.isCancel(menuAutoAnswer)) return cancelled();

  const notifications = await p.confirm({
    message: 'Desktop notifications when limits hit and sessions resume?',
    initialValue: DEFAULTS.notifications,
  });
  if (p.isCancel(notifications)) return cancelled();

  // GUI watching: only meaningful where an autostart daemon can run.
  let guiWatch = false;
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const answer = await p.confirm({
      message: 'Also guard GUI sessions (Claude Code in VS Code/desktop, Codex app/IDE)?\n'
        + '  Installs a small background daemon (launchd/systemd) that watches session\n'
        + '  files for limit stops; revived sessions open in the configured multiplexer and stay visible in\n'
        + '  the GUI\'s own history.',
      initialValue: DEFAULTS.guiWatch,
    });
    if (p.isCancel(answer)) return cancelled();
    guiWatch = answer;
  }

  // Seed message prompts from the existing config so a setup re-run shows —
  // and keeps — values previously set here or via `unsnooze config`.
  const existing = readFileConfig();
  const existingMsgs = existing.resumeMessages
    && typeof existing.resumeMessages === 'object' && !Array.isArray(existing.resumeMessages)
    ? existing.resumeMessages : {};

  const customizeMsg = await p.confirm({
    message: 'Customize the message sent to resume a session?',
    initialValue: false,
  });
  if (p.isCancel(customizeMsg)) return cancelled();

  let resumeMessage = typeof existing.resumeMessage === 'string' && existing.resumeMessage.trim()
    ? existing.resumeMessage : DEFAULTS.resumeMessage;
  if (customizeMsg) {
    const msg = await p.text({
      message: 'Resume message:',
      initialValue: resumeMessage,
      validate: v => (v.trim() ? undefined : 'message cannot be empty'),
    });
    if (p.isCancel(msg)) return cancelled();
    resumeMessage = msg;
  }

  const customizePerAgent = await p.confirm({
    message: 'Set a different resume message for specific agents?',
    initialValue: false,
  });
  if (p.isCancel(customizePerAgent)) return cancelled();

  const resumeMessages = {};
  if (customizePerAgent) {
    for (const agent of listAgents().filter(a => agents.includes(a.id))) {
      const msg = await p.text({
        message: `Message for ${agent.name} (leave empty to use the global message):`,
        initialValue: typeof existingMsgs[agent.id] === 'string' ? existingMsgs[agent.id] : '',
      });
      if (p.isCancel(msg)) return cancelled();
      resumeMessages[agent.id] = typeof msg === 'string' && msg.trim() ? msg : '';
    }
  }

  // Merge over the existing file so a setup re-run keeps settings the wizard
  // doesn't ask about (e.g. per-agent messages set via `unsnooze config`).
  writeConfig({
    ...existing,
    autoResume, menuAutoAnswer, notifications, guiWatch, resumeMessage,
    resumeMessages: { ...existingMsgs, ...resumeMessages },
    agents: Object.fromEntries(listAgents().map(a => [a.id, agents.includes(a.id)])),
  });

  const s = p.spinner();
  s.start('Installing shell wrappers and hooks');
  const { cmdInstall } = await import('./install.js');
  const code = cmdInstall(guiWatch ? ['--yes', '--daemon'] : ['--yes']);
  s.stop(code === 0 ? 'Wrappers and hooks installed' : 'Install hit a problem — see output above');

  p.outro(code === 0
    ? 'Done. Reload your shell (`exec $SHELL`) and use your AI CLIs as usual.\nCheck `unsnooze status` anytime; change settings with `unsnooze config`.'
    : 'Setup incomplete — fix the issue above and re-run `unsnooze setup`.');
  return code;
}

function cancelled() {
  p.cancel('Setup cancelled — nothing was changed. Re-run anytime with `unsnooze setup`.');
  return 1;
}
