import { ogCard, OG_SIZE, OG_CONTENT_TYPE } from '../lib/og-card.jsx';

export const alt = 'unsnooze — while you sleep, the work continues';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return ogCard({
    headline: 'While you sleep, the work continues.',
    sub: 'Auto-resumes Claude Code, Codex & 5 more CLIs the moment the usage limit resets.',
  });
}
