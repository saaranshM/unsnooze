import { ogCard, OG_SIZE, OG_CONTENT_TYPE } from '../../../lib/og-card.jsx';

export const alt = 'unsnooze command reference';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return ogCard({
    headline: 'Every command, with real output.',
    sub: 'status, usage, preview, doctor, and the queued-prompt verbs — each with the output it actually prints.',
  });
}
