import Stars from '../../components/Stars.jsx';
import SiteNav from '../../components/SiteNav.jsx';
import SubFooter from '../../components/SubFooter.jsx';
import FeedbackClient from '../../components/FeedbackClient.jsx';
import { JsonLd, breadcrumbs } from '../../lib/jsonld.js';

// True SSR: every request re-fetches the board so fresh submissions are in the
// server HTML — the one page where per-request rendering earns its keep.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Feedback — report a bug or request a feature',
  description:
    'Hit a limit banner unsnooze missed, a wake that did not happen, or a feature you wish existed? Report bugs and pitch ideas — no account needed — and see what is planned, in progress, and shipped.',
  alternates: { canonical: '/feedback/' },
  openGraph: {
    title: 'unsnooze feedback',
    description: 'Report bugs, pitch features, and see what is planned and shipped.',
    url: '/feedback/',
  },
};

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

async function fetchRows() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/feedback?select=id,created_at,kind,title,details,status&order=created_at.desc&limit=100`,
      {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        cache: 'no-store',
      },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export default async function FeedbackPage() {
  const initialRows = await fetchRows();

  return (
    <div className="subpage">
      <div className="stars-layer stars-dim" aria-hidden="true"><Stars /></div>
      <JsonLd data={breadcrumbs([['unsnooze', '/'], ['Feedback', '/feedback/']])} />
      <SiteNav page="feedback" />
      <main className="wrap subpage-main">
        <header className="sub-hero">
          <p className="eyebrow">bugs &amp; ideas</p>
          <h1 className="sub-title">Make unsnooze better</h1>
          <p className="section-lede">
            Hit a banner it missed, a wake that didn't happen, or a feature you wish existed?
            Tell it here — no account needed. Bugs with logs are best reported via{' '}
            <a href="https://github.com/saaranshM/unsnooze/issues">GitHub issues</a>, where
            you can attach <code className="chip">unsnooze report</code> captures.
          </p>
        </header>
        <FeedbackClient initialRows={initialRows} configured={Boolean(SUPABASE_URL && SUPABASE_KEY)} />
      </main>
      <SubFooter />
    </div>
  );
}
