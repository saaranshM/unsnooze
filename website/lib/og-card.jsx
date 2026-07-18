import { ImageResponse } from 'next/og';

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = 'image/png';

// Shared brand frame for every route's Open Graph card. Satori supports only
// flexbox layout and inline SVG — the chevron is drawn, not typed, because the
// bundled font has no ❯ glyph.
export function ogCard({ headline, sub }) {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 72,
          backgroundColor: '#090c10',
          backgroundImage: 'radial-gradient(ellipse 80% 55% at 50% 120%, rgba(245,158,11,0.35), rgba(251,113,133,0.08) 55%, rgba(9,12,16,0) 75%)',
          color: '#e6edf3',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <svg width="64" height="64" viewBox="0 0 64 64">
            <path d="M18 12 L44 32 L18 52" fill="none" stroke="#f59e0b" strokeWidth="10"
              strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
            <div style={{ fontSize: 56, fontWeight: 700 }}>unsnooze</div>
            <div style={{ fontSize: 28, color: '#5b6470', letterSpacing: 6 }}>z z z</div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.15, maxWidth: 1000 }}>
            {headline}
          </div>
          <div style={{ fontSize: 30, color: '#8b949e', maxWidth: 980 }}>{sub}</div>
        </div>
      </div>
    ),
    { ...OG_SIZE },
  );
}
