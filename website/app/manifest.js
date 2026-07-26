// PWA hygiene only. Google reads the manifest for neither favicons nor the
// search-result site name — those come from the home page <link> set and the
// WebSite/Organization JSON-LD respectively.
export default function manifest() {
  return {
    name: 'unsnooze — auto-resume AI coding sessions',
    short_name: 'unsnooze',
    description:
      'Wakes every limit-stopped AI coding session the moment the usage limit resets.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0d1117',
    theme_color: '#090c10',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
