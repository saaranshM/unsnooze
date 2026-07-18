import { ogCard, OG_SIZE, OG_CONTENT_TYPE } from '../../lib/og-card.jsx';

export const alt = 'unsnooze feedback board';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return ogCard({
    headline: 'Make unsnooze better.',
    sub: 'Report a bug or pitch a feature — no account needed.',
  });
}
