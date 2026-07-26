import { SITE_URL } from './site.js';

const ORG_ID = `${SITE_URL}/#organization`;

// Anchors the brand as an entity: the logo feeds a knowledge panel, and the
// name reinforces what Google shows as the site name in a result.
export function organization() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': ORG_ID,
    name: 'unsnooze',
    url: `${SITE_URL}/`,
    logo: `${SITE_URL}/icon-512.png`,
    sameAs: [
      'https://github.com/saaranshM/unsnooze',
      'https://www.npmjs.com/package/unsnooze',
    ],
  };
}

export function webSite() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'unsnooze',
    url: `${SITE_URL}/`,
    publisher: { '@id': ORG_ID },
  };
}

export function softwareApplication() {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'unsnooze',
    description:
      'Wakes every limit-stopped AI coding session the moment the usage limit resets — Claude Code, Codex CLI, Grok, Qwen, Kimi, OpenCode and Antigravity, in tmux or Zellij.',
    url: `${SITE_URL}/`,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows (WSL)',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    license: 'https://opensource.org/licenses/MIT',
    sameAs: [
      'https://github.com/saaranshM/unsnooze',
      'https://www.npmjs.com/package/unsnooze',
    ],
  };
}

export function faqPage(faq) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map(({ q, text }) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text },
    })),
  };
}

export function breadcrumbs(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map(([name, path], i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name,
      // The final crumb is the current page, which Google asks you not to link.
      ...(i === items.length - 1 ? {} : { item: `${SITE_URL}${path}` }),
    })),
  };
}

export function JsonLd({ data }) {
  return (
    <script
      type="application/ld+json"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
