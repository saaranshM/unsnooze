import { SITE_URL } from '../lib/site.js';
import { readChangelog } from '../lib/changelog.js';

export default async function sitemap() {
  const latestRelease = (await readChangelog())[0]?.date;
  const changelogModified = latestRelease ? new Date(latestRelease) : new Date();

  // Only /changelog/ claims a lastmod, because only /changelog/ has a date that
  // is derived from its own content and can be checked against the page. Google
  // honours lastmod only when it is "consistently and verifiably
  // accurate", and a shared release date stamped across every page is neither —
  // the docs, for instance, get edited between releases. An absent lastmod is
  // handled gracefully; a wrong one teaches Google to ignore the whole signal.
  const docs = ['', 'commands/', 'settings/', 'fleet/', 'troubleshooting/'];

  return [
    { url: `${SITE_URL}/`, changeFrequency: 'weekly', priority: 1 },
    ...docs.map((slug) => ({
      url: `${SITE_URL}/docs/${slug}`,
      changeFrequency: 'weekly',
      priority: slug === '' ? 0.9 : 0.8,
    })),
    { url: `${SITE_URL}/changelog/`, lastModified: changelogModified, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${SITE_URL}/feedback/`, changeFrequency: 'weekly', priority: 0.3 },
  ];
}
