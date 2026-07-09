// `unsnooze report [pane]` — capture a pane (ANSI-stripped), show it to the
// user, and print a pre-filled GitHub issue URL. Exists mainly so early Grok
// Build users can contribute real limit-banner text (the patterns for grok
// are generic until someone shows us the actual banner).

import { capturePane, currentPaneId } from './tmux.js';
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
  const pane = paneArg || currentPaneId();
  if (!pane) {
    console.error('unsnooze report: no pane (run inside tmux or pass a pane id, e.g. %3)');
    return 2;
  }
  let text;
  try {
    text = stripAnsi(await capturePane(pane, 200));
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
