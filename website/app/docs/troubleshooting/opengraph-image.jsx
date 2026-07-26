import { ogCard, OG_SIZE, OG_CONTENT_TYPE } from '../../../lib/og-card.jsx';

export const alt = 'unsnooze troubleshooting and security';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return ogCard({
    headline: 'When the wake didn’t happen.',
    sub: 'What unsnooze doctor reports, why a banner can be missed, the security model, and the local dev loop.',
  });
}
