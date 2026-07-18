import Reveal from './Reveal.jsx';

const QA = [
  {
    q: 'Does this get around the rate limit?',
    a: <>No. unsnooze waits for the reset exactly like you would, resumes once, and verifies
      the limit actually lifted. It replaces the 4am alarm, not the limit.</>,
  },
  {
    q: 'What if my laptop was asleep or the terminal was closed?',
    a: <>Reset times are stored as absolute timestamps and checked every 30 seconds, so a
      laptop that slept through the reset resumes on the next tick — and dead panes are
      reopened by session id in a fresh multiplexer pane.</>,
  },
  {
    q: 'Why did resuming a big session eat so much quota?',
    a: <>Prompt-cache expiry, not unsnooze. After hours stopped at a limit the provider's
      cache is long gone, so the first wake message — unsnooze's or a hand-typed
      “continue,” identical cost — re-reads the entire context at full price. The{' '}
      <code className="chip">contextGuard</code> setting estimates the size before waking and
      can notify you or hold the session for a manual decision.{' '}
      <code className="chip">/compact</code> before the wall is what actually helps.</>,
  },
  {
    q: 'What if the repo changed while a session slept?',
    a: <>unsnooze fingerprints the workspace (HEAD plus uncommitted state) at stop time and
      re-checks at wake. By default the session resumes with a heads-up in the wake message;
      <code className="chip">workspaceGuard=pause</code> holds it until you review the diff.</>,
  },
  {
    q: 'Does it work on Windows?',
    a: <>Via WSL — which is where the agent CLIs live on Windows anyway. Everything works as
      on Linux, and desktop notifications arrive as native Windows toasts through
      PowerShell. Native Windows without WSL isn't supported: with no tmux or Zellij there's
      no pane to watch, and unsnooze says so instead of breaking your CLI.</>,
  },
  {
    q: 'What does it need?',
    a: <>Node ≥ 20 and tmux ≥ 3.2 or Zellij, on macOS, Linux, or Windows via WSL. Wrappers
      install into <code className="chip">~/.zshrc</code> / <code className="chip">~/.bashrc</code>;
      everything is reversible with <code className="chip">unsnooze uninstall</code>.</>,
  },
];

export default function Faq() {
  return (
    <section id="faq">
      <Reveal>
        <p className="eyebrow">asked at 4am</p>
        <h2>Questions people <span className="hl">actually ask</span></h2>
      </Reveal>
      <Reveal delay={0.08}>
        <div className="faq">
          {QA.map(({ q, a }) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
