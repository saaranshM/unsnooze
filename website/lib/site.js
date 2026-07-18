// Single source for the canonical origin — swap NEXT_PUBLIC_SITE_URL when the
// custom domain arrives and every canonical, OG url, sitemap and JSON-LD id
// follows.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://unsnooze.vercel.app';
