import { ogCard, OG_SIZE, OG_CONTENT_TYPE } from '../../lib/og-card.jsx';

export const alt = 'unsnooze changelog';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return ogCard({
    headline: 'Every release, straight from the repo.',
    sub: 'The unsnooze changelog — nothing shown that has not shipped.',
  });
}
