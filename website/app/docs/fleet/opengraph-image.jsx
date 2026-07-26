import { ogCard, OG_SIZE, OG_CONTENT_TYPE } from '../../../lib/og-card.jsx';

export const alt = 'unsnooze ssh multi-host fleet';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return ogCard({
    headline: 'One dashboard, every machine.',
    sub: 'Watch limit-stopped sessions across your ssh fleet — read-only by default, no new service to run.',
  });
}
