// `unsnooze report [pane]` — capture a pane (ANSI-stripped), show it to the
// user, and print a pre-filled GitHub issue URL. Exists mainly so early Grok
// Build users can contribute real limit-banner text (the patterns for grok
// are generic until someone shows us the actual banner).

import { getMultiplexer } from './multiplexer.js';
import { stripAnsi } from './patterns.js';

export const REPO_URL = 'https://github.com/saaranshM/unsnooze';
const MAX_CAPTURE_CHARS = 3000;

export function buildIssueUrl(agentId, captureText) {
  const title = `[banner-capture] ${agentId}: limit banner sample`;
  const body = [
    `**Agent CLI:** ${agentId}`,
    '',
    'Pane capture (redact anything sensitive before submitting!):',
    '',
    '```text',
    captureText.slice(-MAX_CAPTURE_CHARS),
    '```',
  ].join('\n');
  return `${REPO_URL}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

export async function cmdReport(rest) {
  const [agentId = 'grok', paneArg] = rest;
  const selected = getMultiplexer();
  let paneOwner = selected.name === 'zellij'
    ? (process.env.UNSNOOZE_PANE_OWNER || process.env.ZELLIJ_SESSION_NAME || null) : null;
  let pane = paneArg || selected.currentPaneId();
  if (paneArg && selected.name === 'zellij' && paneArg.includes(':')) {
    [paneOwner, pane] = paneArg.split(/:(.*)/s, 2);
  }
  if (!pane) {
    console.error('unsnooze report: no pane (run inside a multiplexer or pass %3 / owner:3)');
    return 2;
  }
  const mux = getMultiplexer(selected.name, { owner: paneOwner });
  let text;
  try {
    text = stripAnsi(await mux.capturePane(pane, 200));
  } catch (err) {
    console.error(`unsnooze report: cannot capture pane ${pane}: ${err.message}`);
    return 1;
  }
  console.log('--- pane capture (review & redact before sharing) ---');
  console.log(text.trimEnd());
  console.log('--- end capture ---\n');
  console.log('If this shows a usage-limit banner, please open an issue so detection improves:');
  console.log(buildIssueUrl(agentId, text));
  return 0;
}
