// Single source for the FAQ: `jsx` renders on the page, `text` feeds the
// FAQPage JSON-LD (plain strings — structured data must not contain markup).

const C = ({ children }) => <code className="chip">{children}</code>;

export const FAQ = [
  {
    q: 'Does this get around the rate limit?',
    text: 'No. unsnooze waits for the reset exactly like you would, resumes once, and verifies the limit actually lifted. It replaces the 4am alarm, not the limit.',
    jsx: <>No. unsnooze waits for the reset exactly like you would, resumes once, and verifies
      the limit actually lifted. It replaces the 4am alarm, not the limit.</>,
  },
  {
    q: 'What if my laptop was asleep or the terminal was closed?',
    text: 'Reset times are stored as absolute timestamps and checked every 30 seconds, so a laptop that slept through the reset resumes on the next tick — and dead panes are reopened by session id in a fresh multiplexer pane.',
    jsx: <>Reset times are stored as absolute timestamps and checked every 30 seconds, so a
      laptop that slept through the reset resumes on the next tick — and dead panes are
      reopened by session id in a fresh multiplexer pane.</>,
  },
  {
    q: 'Why did resuming a big session eat so much quota?',
    text: "Prompt-cache expiry, not unsnooze. After hours stopped at a limit the provider's cache is long gone, so the first wake message — unsnooze's or a hand-typed \"continue\", identical cost — re-reads the entire context at full price. The contextGuard setting estimates the size before waking and can notify you or hold the session for a manual decision. /compact before the wall is what actually helps.",
    jsx: <>Prompt-cache expiry, not unsnooze. After hours stopped at a limit the provider's
      cache is long gone, so the first wake message — unsnooze's or a hand-typed
      “continue,” identical cost — re-reads the entire context at full price. The{' '}
      <C>contextGuard</C> setting estimates the size before waking and can notify you or
      hold the session for a manual decision. <C>/compact</C> before the wall is what
      actually helps.</>,
  },
  {
    q: 'What if the repo changed while a session slept?',
    text: 'unsnooze fingerprints the workspace (HEAD plus uncommitted state) at stop time and re-checks at wake. By default the session resumes with a heads-up in the wake message; workspaceGuard=pause holds it until you review the diff.',
    jsx: <>unsnooze fingerprints the workspace (HEAD plus uncommitted state) at stop time and
      re-checks at wake. By default the session resumes with a heads-up in the wake message;
      <C>workspaceGuard=pause</C> holds it until you review the diff.</>,
  },
  {
    q: 'Does it work on Windows?',
    text: 'Yes, natively. PowerShell wrappers go into your $PROFILE, the StopFailure hook is written in cmd syntax, and the daemon autostarts from a logon Scheduled Task. With no multiplexer installed unsnooze runs headless — it detects stops from the hook and the session transcript instead of a pane, so limits are still caught and resumed. WSL remains the richer option, since that is where tmux lives and where you get menu answering and a live pane to attach to.',
    jsx: <>Yes, natively. PowerShell wrappers go into your <C>$PROFILE</C>, the StopFailure
      hook is written in cmd syntax, and the daemon autostarts from a logon Scheduled Task.
      With no multiplexer installed unsnooze runs <strong>headless</strong> — it detects
      stops from the hook and the session transcript instead of a pane, so limits are still
      caught and resumed. WSL remains the richer option, since that is where tmux lives and
      where you get menu answering and a live pane to attach to.</>,
  },
  {
    q: 'Claude Code can auto-continue now — what does unsnooze add?',
    text: "Claude's own auto-continue covers the 5-hour limit, in-process, for Claude. It cannot fire when the app is closed, the machine slept, or you are on a headless box over ssh, and it does not cover the weekly limit or any other CLI. unsnooze watches from outside the session, so it survives all of that, and it resumes Codex, Grok, Qwen, Kimi, OpenCode and Antigravity too. When Claude does resume itself, unsnooze notices and stands aside rather than sending a second wake — status says so explicitly.",
    jsx: <>Claude's own auto-continue covers the <strong>5-hour</strong> limit, in-process, for
      Claude. It cannot fire when the app is closed, the machine slept, or you are on a
      headless box over ssh — and it does not cover the <strong>weekly</strong> limit or any
      other CLI. unsnooze watches from outside the session, so it survives all of that, and
      it resumes Codex, Grok, Qwen, Kimi, OpenCode and Antigravity too. When Claude does
      resume itself, unsnooze notices and stands aside rather than sending a second wake —{' '}
      <C>unsnooze status</C> says so explicitly.</>,
  },
  {
    q: 'Does it work with Claude Design?',
    text: 'Yes, for design work run through the claude-design MCP server inside Claude Code — run unsnooze design setup to wire it up. Design draws from the same 5-hour and weekly pool as everything else, so a long design run stops like any other session and is resumed the same way. unsnooze does not automate the web canvas at claude.ai/design: Anthropic\u2019s Consumer Terms bar automated access to claude.ai, and accounts have been terminated for it.',
    jsx: <>Yes, for design work run through the <strong>claude-design MCP server</strong> inside
      Claude Code — run <C>unsnooze design setup</C> to wire it up. Design draws from the same
      5-hour and weekly pool as everything else, so a long design run stops like any other
      session and is resumed the same way. unsnooze does <em>not</em> automate the web canvas
      at claude.ai/design: Anthropic&rsquo;s Consumer Terms bar automated access to claude.ai,
      and accounts have been terminated for it.</>,
  },
  {
    q: 'What does it need?',
    text: 'Node ≥ 20, on macOS, Linux or Windows. A multiplexer (tmux ≥ 3.2, Zellij, herdr or cmux) gives you pane-level watching; without one unsnooze runs headless and still resumes. Wrappers install into ~/.zshrc / ~/.bashrc, or your PowerShell $PROFILE; everything is reversible with unsnooze uninstall.',
    jsx: <>Node ≥ 20, on macOS, Linux or Windows. A multiplexer (tmux ≥ 3.2, Zellij, herdr or
      cmux) gives you pane-level watching; without one unsnooze runs headless and still
      resumes. Wrappers install into <C>~/.zshrc</C> / <C>~/.bashrc</C>, or your PowerShell{' '}
      <C>$PROFILE</C>; everything is reversible with <C>unsnooze uninstall</C>.</>,
  },
];
