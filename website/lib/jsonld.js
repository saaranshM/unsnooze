import { SITE_URL } from './site.js';

export function webSite() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'unsnooze',
    url: `${SITE_URL}/`,
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
      item: `${SITE_URL}${path}`,
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
