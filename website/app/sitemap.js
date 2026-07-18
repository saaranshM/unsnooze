import { SITE_URL } from '../lib/site.js';
import { readChangelog } from '../lib/changelog.js';

export default async function sitemap() {
  const latestRelease = (await readChangelog())[0]?.date;
  const changelogModified = latestRelease ? new Date(latestRelease) : new Date();

  return [
    { url: `${SITE_URL}/`, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/docs/`, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${SITE_URL}/changelog/`, lastModified: changelogModified, changeFrequency: 'weekly', priority: 0.6 },
    { url: `${SITE_URL}/feedback/`, changeFrequency: 'daily', priority: 0.4 },
  ];
}
