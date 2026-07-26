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

        <section className="doc-sec feedback-notes">
          <h2>What is worth reporting</h2>
          <p>The most valuable reports are the ones nobody else can reproduce from the
            outside. In rough order of usefulness:</p>
          <ul>
            <li><strong>A limit banner unsnooze did not recognise.</strong> Agents change their
              wording without warning, and a banner that is not matched is a session that
              never gets recorded. <code className="chip">unsnooze report</code> captures the
              exact text — attach it and the adapter can be fixed in one release.</li>
            <li><strong>A wake that did not happen.</strong> Say which agent, which
              multiplexer, and what <code className="chip">unsnooze status</code> showed at the
              time. If the reset time looked wrong, that detail matters most — a reset parsed
              as relative rather than absolute is a different bug from a missed wake.</li>
            <li><strong>A wake that happened at the wrong moment.</strong> Too early usually
              means a misread reset; too late usually means the machine slept through it.</li>
            <li><strong>Anything that typed into the wrong pane</strong>, which is treated as
              the most serious class of bug this tool can have.</li>
            <li><strong>Ideas.</strong> A flag you keep wishing existed, an agent that is not
              supported yet, or a workflow that does not fit.</li>
          </ul>

          <h3>What the statuses mean</h3>
          <p>Every item on the board carries one:</p>
          <ul>
            <li><code className="chip">new</code> — received, not yet triaged.</li>
            <li><code className="chip">planned</code> — accepted and queued for a release.</li>
            <li><code className="chip">in-progress</code> — being built now.</li>
            <li><code className="chip">shipped</code> — released; the{' '}
              <a href="/changelog/">changelog</a> records which version.</li>
            <li><code className="chip">declined</code> — out of scope, with the reasoning
              given rather than silence.</li>
          </ul>

          <h3>Here, or a GitHub issue?</h3>
          <p>Use this board when you want to say something quickly and without an account —
            it is the lower-friction path, and it is read. Open a{' '}
            <a href="https://github.com/saaranshM/unsnooze/issues">GitHub issue</a> instead
            when you have logs, a stack trace, or a{' '}
            <code className="chip">unsnooze report</code> capture to attach, since files
            cannot be uploaded here. Anything touching the security boundary should follow{' '}
            <a href="https://github.com/saaranshM/unsnooze/blob/main/SECURITY.md">SECURITY.md</a>{' '}
            rather than either public channel.</p>
          <p>Before reporting a wake that did not fire, it is worth running{' '}
            <code className="chip">unsnooze doctor</code> — it reports problems rather than a
            checklist, so a healthy install answers in one line. The{' '}
            <a href="/docs/troubleshooting/">troubleshooting guide</a> covers the common
            causes.</p>
        </section>
      </main>
      <SubFooter />
    </div>
  );
}
