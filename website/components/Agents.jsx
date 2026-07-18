import Reveal from './Reveal.jsx';

const CORE = [
  {
    name: 'Claude Code', tag: 'stable',
    body: <>Dual-channel: the <code className="chip">StopFailure</code> hook (authoritative,
      carries the session id) plus pane scraping for banners and the interactive limit
      menu — always answered with “Stop and wait for limit to reset,” never a blind Enter.
      Dead sessions revive via <code className="chip">claude --resume</code>.</>,
  },
  {
    name: 'Codex CLI', tag: 'stable',
    body: <>Detects the exact banner strings from the Codex source and parses every reset
      format — <em>“try again at 3:51 PM,”</em> absolute dates, <em>“in 4 days 20
      hours.”</em> Dead sessions revive via <code className="chip">codex resume</code>.</>,
  },
  {
    name: 'GUI surfaces', tag: 'daemon', wide: true,
    body: <>Sessions in Claude Code's VS Code extension, the ChatGPT desktop app, and Claude
      desktop have no pane to scrape — so the daemon tails the session files those surfaces
      already write. Codex rollouts even carry the exact epoch reset time. At reset, the
      session revives in a multiplexer pane; it's the same session file, so the conversation
      stays visible in the GUI's own history.</>,
  },
];

const EXPERIMENTAL = [
  {
    cmd: 'grok',
    desc: <>Claude-compatible hooks (including <code className="chip">StopFailure</code>) work
      today; banner patterns stay generic until xAI documents the strings.</>,
  },
  {
    cmd: 'qwen',
    desc: <>Hook plus verbatim quota scrapes. Qwen never prints a reset time — 5-hour
      fallback, self-corrected on verify.</>,
  },
  {
    cmd: 'kimi',
    desc: <>Anchors on the red 429 line kimi stops with. Resume ids verified on disk first —
      kimi silently starts a <em>new</em> session for unknown ids.</>,
  },
  {
    cmd: 'opencode',
    desc: <>Retries limits itself, forever — so unsnooze never touches a live pane. Its job:
      reviving sessions whose process died mid-wait.</>,
  },
  {
    cmd: 'agy',
    desc: <>Antigravity, the Gemini-CLI successor. Parses <em>“Refreshes in 6 days…”</em> as
      the weekly cap; treats 503 capacity errors as transient, not a limit.</>,
  },
];

export default function Agents() {
  return (
    <section id="agents">
      <Reveal>
        <p className="eyebrow">who it watches</p>
        <h2>Seven CLIs, <span className="hl">one ledger</span></h2>
        <p className="section-lede">
          Terminal sessions are watched through the shell wrapper and your multiplexer;
          GUI sessions through the files they already write. One shared ledger, one daemon,
          every project at once.
        </p>
      </Reveal>

      <div className="agents-core">
        {CORE.map((c, i) => (
          <Reveal key={c.name} delay={Math.min(i * 0.06, 0.12)} className={c.wide ? 'cell wide' : 'cell'}>
            <h3>{c.name} <span className="tag stable">{c.tag}</span></h3>
            <p>{c.body}</p>
          </Reveal>
        ))}
      </div>

      <Reveal>
        <div className="exp-head">
          <span className="tag exp">experimental</span>
          <span>Off by default — enable per agent in <code className="chip">unsnooze setup</code>.
            Hit a banner one missed? <code className="chip">unsnooze report</code> captures are
            how these get good.</span>
        </div>
        <div className="exp-rows">
          {EXPERIMENTAL.map((e) => (
            <div className="exp-row" key={e.cmd}>
              <code>{e.cmd}</code>
              <span>{e.desc}</span>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
