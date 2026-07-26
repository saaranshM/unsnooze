import './globals.css';
import { SITE_URL } from '../lib/site.js';

export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'unsnooze — auto-resume Claude Code & Codex when the usage limit resets',
    template: '%s · unsnooze',
  },
  description:
    'unsnooze wakes every limit-stopped AI coding session the moment the usage limit resets — Claude Code, Codex CLI, Grok, Qwen, Kimi, OpenCode, Antigravity — in tmux or Zellij, across all your projects.',
  applicationName: 'unsnooze',
  keywords: [
    'claude code usage limit', 'auto resume claude code', 'codex rate limit',
    'claude code 5 hour limit', 'ai coding agent auto resume', 'tmux', 'zellij',
  ],
  // Served from public/ rather than the app/icon.* convention: those emit a
  // hashed route-handler URL with a hardcoded no-cache header, and Google reads
  // the icon set off the home page markup. /favicon.ico goes first — it is the
  // path every crawler, browser and feed reader requests blind.
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48', type: 'image/x-icon' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
  },
  openGraph: {
    type: 'website',
    siteName: 'unsnooze',
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
  },
};

export const viewport = {
  themeColor: '#090c10',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
