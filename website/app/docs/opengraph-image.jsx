import { ogCard, OG_SIZE, OG_CONTENT_TYPE } from '../../lib/og-card.jsx';

export const alt = 'unsnooze documentation';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return ogCard({
    headline: 'The unsnooze docs.',
    sub: 'Install, every command with real examples, all settings, the ssh fleet, guards, and the security model.',
  });
}
