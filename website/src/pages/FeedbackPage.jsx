import { useEffect, useState } from 'react';
import SiteNav from '../components/SiteNav.jsx';
import SubFooter from '../components/SubFooter.jsx';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_KEY);

// Thin PostgREST client — inserts and reads on the `feedback` table are the
// only two calls this page ever makes, so no client library is needed.
async function api(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return res.status === 204 || opts.headers?.Prefer === 'return=minimal' ? null : res.json();
}

const listFeedback = () =>
  api('feedback?select=id,created_at,kind,title,details,status&order=created_at.desc&limit=100');

const submitFeedback = (row) =>
  api('feedback', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });

const STATUS_CLASS = {
  new: 'st-new', planned: 'st-planned', 'in-progress': 'st-progress',
  shipped: 'st-shipped', declined: 'st-declined',
};

function when(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function Form({ onSubmitted }) {
  const [kind, setKind] = useState('bug');
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [contact, setContact] = useState('');
  const [trap, setTrap] = useState(''); // honeypot — real users never see it
  const [state, setState] = useState('idle'); // idle | sending | done | error

  const submit = async (e) => {
    e.preventDefault();
    if (title.trim().length < 3) return;
    if (trap) { setState('done'); return; } // bots fill the hidden field; pretend success
    setState('sending');
    try {
      await submitFeedback({
        kind,
        title: title.trim().slice(0, 120),
        details: details.trim().slice(0, 4000) || null,
        contact: contact.trim().slice(0, 120) || null,
      });
      setTitle(''); setDetails(''); setContact('');
      setState('done');
      onSubmitted();
    } catch {
      setState('error');
    }
  };

  return (
    <form className="fb-form" onSubmit={submit}>
      <div className="fb-kind" role="radiogroup" aria-label="Type">
        <button type="button" role="radio" aria-checked={kind === 'bug'}
          className={kind === 'bug' ? 'active' : ''} onClick={() => setKind('bug')}>
          bug report
        </button>
        <button type="button" role="radio" aria-checked={kind === 'idea'}
          className={kind === 'idea' ? 'active' : ''} onClick={() => setKind('idea')}>
          feature idea
        </button>
      </div>

      <label>
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required
          minLength={3} placeholder={kind === 'bug'
            ? 'e.g. Codex banner with a date range isn’t detected'
            : 'e.g. A --quiet flag for status in scripts'} />
      </label>

      <label>
        <span>Details <em>(optional — for bugs: agent, OS, and what unsnooze logged;{' '}
          <code className="chip">unsnooze report</code> output is gold)</em></span>
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} maxLength={4000}
          rows={5} placeholder="What happened, what you expected, how to reproduce it…" />
      </label>

      <label>
        <span>Contact <em>(optional — email or GitHub handle, only if you want a reply)</em></span>
        <input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={120}
          placeholder="you@example.com · @handle" />
      </label>

      <input className="fb-trap" type="text" value={trap} tabIndex={-1} autoComplete="off"
        aria-hidden="true" onChange={(e) => setTrap(e.target.value)} name="website" />

      <div className="fb-actions">
        <button className="fb-submit" type="submit" disabled={state === 'sending'}>
          {state === 'sending' ? 'sending…' : 'submit'}
        </button>
        {state === 'done' && <span className="fb-ok">✓ received — thank you</span>}
        {state === 'error' && <span className="fb-err">something went wrong — try again, or open a{' '}
          <a href="https://github.com/saaranshM/unsnooze/issues">GitHub issue</a></span>}
      </div>
    </form>
  );
}

function Board({ refreshKey }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    let alive = true;
    listFeedback()
      .then((r) => { if (alive) setRows(r); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [refreshKey]);

  if (error) return <p className="fb-note">The board couldn't load right now — submissions still work.</p>;
  if (!rows) return <p className="fb-note">loading…</p>;

  const visible = rows.filter((r) => filter === 'all' || r.kind === filter);

  return (
    <div className="fb-board">
      <div className="fb-filter" role="tablist" aria-label="Filter">
        {['all', 'bug', 'idea'].map((f) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f}
            className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
            {f === 'all' ? `all (${rows.length})` : `${f}s (${rows.filter((r) => r.kind === f).length})`}
          </button>
        ))}
      </div>
      {visible.length === 0 && <p className="fb-note">Nothing here yet — yours could be first.</p>}
      {visible.map((r) => (
        <article className="fb-row" key={r.id}>
          <div className="fb-row-head">
            <span className={`fb-badge ${r.kind}`}>{r.kind}</span>
            <h3>{r.title}</h3>
            <span className={`fb-status ${STATUS_CLASS[r.status] || 'st-new'}`}>{r.status}</span>
            <time dateTime={r.created_at}>{when(r.created_at)}</time>
          </div>
          {r.details && <p>{r.details}</p>}
        </article>
      ))}
    </div>
  );
}

export default function FeedbackPage() {
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="subpage">
      <SiteNav root="../" page="feedback" />
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

        {CONFIGURED ? (
          <>
            <Form onSubmitted={() => setRefreshKey((k) => k + 1)} />
            <h2 className="fb-board-title">What others have said</h2>
            <Board refreshKey={refreshKey} />
          </>
        ) : (
          <p className="fb-note fb-unconfigured">
            The feedback board isn't wired up in this build. Meanwhile:{' '}
            <a href="https://github.com/saaranshM/unsnooze/issues">open a GitHub issue</a> —
            bug reports and feature ideas both welcome.
          </p>
        )}
      </main>
      <SubFooter />
    </div>
  );
}
