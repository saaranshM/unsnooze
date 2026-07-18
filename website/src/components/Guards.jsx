import Reveal from './Reveal.jsx';

const GUARDS = [
  {
    key: 'usageWarn', def: 'notify', title: 'Pre-wall warnings',
    body: <>The daemon warns at 80% and 95% of the window's quota, and at 30 and 10 minutes
      to the wall at your current pace — deduped once per window. It may <em>suggest</em>{' '}
      <code className="chip">/compact</code> so the eventual wake is cheap; it never
      auto-types it.</>,
  },
  {
    key: 'contextGuard', def: 'inform', title: 'Cold-cache wake guard',
    body: <>Waking after hours means the provider's prompt cache is long gone — the first
      message re-reads the <em>entire</em> context at full price. unsnooze estimates the
      size (<code className="chip">ctx ~152k tok</code>) and notifies you, or holds sessions
      above a threshold for a manual decision.</>,
  },
  {
    key: 'workspaceGuard', def: 'inform', title: 'Stale-workspace guard',
    body: <>The repo's HEAD and dirty state are fingerprinted at stop time. If anything
      changed before the wake, the resumed agent is told to re-read before acting — or the
      session is held and <code className="chip">resume-now</code> shows the diff first.</>,
  },
  {
    key: 'notifyChannel', def: 'auto', title: 'Notifications, your way',
    body: <>OS toasts (macOS, Linux, native Windows toasts from WSL), terminal OSC banners
      in iTerm2 / kitty / WezTerm / Ghostty, a plain BEL, or{' '}
      <a href="https://ntfy.sh">ntfy</a> push to your phone — for limit hit, resumed, and
      gave-up.</>,
  },
  {
    key: 'menuAutoAnswer', def: 'true', title: 'Menu answering, on your terms',
    body: <>Claude's limit menu is driven only when it can be read exactly; turn it off and
      unsnooze is watch-only. <code className="chip">autoResume off</code> goes further:
      track everything, type nothing.</>,
  },
  {
    key: 'reapResumed', def: 'false', title: 'Tidy panes, eventually',
    body: <><code className="chip">unsnooze reap</code> closes finished panes and empty
      sessions — dry-run by default, auto-reap strictly opt-in after seven idle days.</>,
  },
];

export default function Guards() {
  return (
    <section id="guards">
      <Reveal>
        <p className="eyebrow">04:15 <span className="tick">·</span> the details that hold</p>
        <h2>Guards for everything <span className="hl">that can go wrong</span></h2>
        <p className="section-lede">
          Every guard is a config key — set once in <code className="chip">unsnooze setup</code>,
          change any time with <code className="chip">unsnooze config set</code>, override per
          environment with <code className="chip">UNSNOOZE_*</code> vars.
        </p>
      </Reveal>
      <div className="guards">
        {GUARDS.map((g, i) => (
          <Reveal key={g.key} delay={Math.min(i * 0.04, 0.16)} className="guard">
            <h3>
              {g.title} <code>{g.key}</code>
              <span className="default">default: {g.def}</span>
            </h3>
            <p>{g.body}</p>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
