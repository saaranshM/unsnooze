/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the /docs/ style URL shapes the old site (and its inbound links) used.
  trailingSlash: true,

  async headers() {
    return [
      {
        // A day, not a year: these URLs are deliberately unhashed so they stay
        // stable for Google, which means a bad icon can only be fixed in place.
        source: '/:path(favicon.ico|icon.svg|apple-touch-icon.png|icon-192.png|icon-512.png)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' },
        ],
      },
    ];
  },
};

export default nextConfig;
