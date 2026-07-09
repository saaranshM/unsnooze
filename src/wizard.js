// `unsnooze setup` — first-run interactive wizard (also invoked by a bare
// `unsnooze install` in a TTY with no saved config). Detects installed agent
// CLIs, asks for toggles, writes config.json, then wires wrappers + hooks.

import { execFileSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { listAgents } from './agents/index.js';
import { isCommunityGrokCli } from './agents/grok.js';
import { DEFAULTS, writeConfig } from './settings.js';

export function detectInstalledAgents({ which = defaultWhich } = {}) {
  return listAgents().map(agent => ({ agent, installed: which(agent.bin) }));
}

function defaultWhich(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export async function runWizard() {
  p.intro('unsnooze — wake every limit-stopped AI coding session automatically');

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

  const customizeMsg = await p.confirm({
    message: 'Customize the message sent to resume a session?',
    initialValue: false,
  });
  if (p.isCancel(customizeMsg)) return cancelled();

  let resumeMessage = DEFAULTS.resumeMessage;
  if (customizeMsg) {
    const msg = await p.text({
      message: 'Resume message:',
      initialValue: DEFAULTS.resumeMessage,
      validate: v => (v.trim() ? undefined : 'message cannot be empty'),
    });
    if (p.isCancel(msg)) return cancelled();
    resumeMessage = msg;
  }

  writeConfig({
    autoResume, menuAutoAnswer, notifications, resumeMessage,
    agents: Object.fromEntries(listAgents().map(a => [a.id, agents.includes(a.id)])),
  });

  const s = p.spinner();
  s.start('Installing shell wrappers and hooks');
  const { cmdInstall } = await import('./install.js');
  const code = cmdInstall(['--yes']);
  s.stop(code === 0 ? 'Wrappers and hooks installed' : 'Install hit a problem — see output above');

  p.outro(code === 0
    ? 'Done. Reload your shell (`exec $SHELL`) and use claude/codex/grok as usual.\nCheck `unsnooze status` anytime; change settings with `unsnooze config`.'
    : 'Setup incomplete — fix the issue above and re-run `unsnooze setup`.');
  return code;
}

function cancelled() {
  p.cancel('Setup cancelled — nothing was changed. Re-run anytime with `unsnooze setup`.');
  return 1;
}
