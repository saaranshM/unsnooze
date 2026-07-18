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
    text: "Via WSL — which is where the agent CLIs live on Windows anyway. Everything works as on Linux, and desktop notifications arrive as native Windows toasts through PowerShell. Native Windows without WSL isn't supported: with no tmux or Zellij there's no pane to watch, and unsnooze says so instead of breaking your CLI.",
    jsx: <>Via WSL — which is where the agent CLIs live on Windows anyway. Everything works as
      on Linux, and desktop notifications arrive as native Windows toasts through
      PowerShell. Native Windows without WSL isn't supported: with no tmux or Zellij there's
      no pane to watch, and unsnooze says so instead of breaking your CLI.</>,
  },
  {
    q: 'What does it need?',
    text: 'Node ≥ 20 and tmux ≥ 3.2 or Zellij, on macOS, Linux, or Windows via WSL. Wrappers install into ~/.zshrc / ~/.bashrc; everything is reversible with unsnooze uninstall.',
    jsx: <>Node ≥ 20 and tmux ≥ 3.2 or Zellij, on macOS, Linux, or Windows via WSL. Wrappers
      install into <C>~/.zshrc</C> / <C>~/.bashrc</C>; everything is reversible with{' '}
      <C>unsnooze uninstall</C>.</>,
  },
];
