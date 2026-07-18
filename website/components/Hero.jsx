'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { LiveDemo } from './Terminal.jsx';
import InstallPill from './InstallPill.jsx';

const AGENTS = [
  'Claude Code', 'Codex CLI', 'Grok Build', 'Qwen Code', 'Kimi CLI',
  'OpenCode', 'Antigravity', 'VS Code extension', 'ChatGPT desktop',
  'Claude desktop', 'tmux', 'Zellij',
];

export default function Hero() {
  const reduced = useReducedMotion();
  const enter = (delay) => ({
    initial: reduced ? false : { opacity: 0, y: 30 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.55, delay: delay * 0.6, ease: [0.22, 1, 0.36, 1] },
  });
  const track = [...AGENTS, ...AGENTS];

  return (
    <header className="hero">
      <motion.p className="eyebrow" {...enter(0)}>
        23:58 <span className="tick">·</span> somewhere in your terminal
      </motion.p>
      <motion.h1 {...enter(0.08)}>
        While you sleep,<br />the work <span className="wake">continues</span>.
      </motion.h1>
      <motion.p className="lede" {...enter(0.18)}>
        When Claude Code, Codex, or any of your AI coding agents hits the 5-hour or
        weekly usage limit, the session just… stops. <strong>unsnooze tracks every
        limit-stopped session across all your projects and wakes each one — in tmux
        or Zellij — the moment the limit resets.</strong> Even if your laptop slept
        through it.
      </motion.p>

      <motion.div {...enter(0.28)}>
        <InstallPill />
        <div className="badges">
          <span>v1.13</span><span>MIT</span><span>Node ≥ 20</span>
          <span>tmux · Zellij</span><span>macOS · Linux · WSL</span><span>zero telemetry</span>
        </div>
      </motion.div>

      <motion.div {...enter(0.4)}>
        <LiveDemo />
      </motion.div>

      <motion.div className="marquee" aria-hidden="true" {...enter(0.5)}>
        <div className="marquee-track">
          {track.map((name, i) => (
            <span key={i}>{name}<span className="sep">❯</span></span>
          ))}
        </div>
      </motion.div>
    </header>
  );
}