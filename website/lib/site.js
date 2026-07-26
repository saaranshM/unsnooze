// Single source for the canonical origin — swap NEXT_PUBLIC_SITE_URL when the
// custom domain arrives and every canonical, OG url, sitemap and JSON-LD id
// follows.
// The fallback must be the live custom domain, not the vercel.app alias: if the
// env var is ever dropped from an environment, a build would otherwise ship
// canonicals pointing at a different hostname — the fastest way to deindex.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://unsnooze.combustortech.in';
