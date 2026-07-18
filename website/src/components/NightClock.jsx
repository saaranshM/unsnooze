import { useState } from 'react';
import { useScroll, useMotionValueEvent } from 'framer-motion';

// The page is one night: scroll position maps to the clock,
// 23:58 at the top of the page, 07:22 at the bottom.
const START = 23 * 60 + 58;
const SPAN = 24 * 60 + (7 * 60 + 22) - START; // minutes from 23:58 to 07:22

const PHASES = [
  [0.1, 'the wall'],
  [0.26, 'the ledger'],
  [0.62, 'the wait'],
  [0.8, 'the wake'],
  [0.92, 'verified'],
  [1.01, 'the morning'],
];

export default function NightClock() {
  const { scrollYProgress } = useScroll();
  const [state, setState] = useState({ time: '23:58', phase: 'the wall', dawn: false });

  useMotionValueEvent(scrollYProgress, 'change', (p) => {
    const mins = Math.round(START + p * SPAN) % (24 * 60);
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    const phase = PHASES.find(([limit]) => p < limit)[1];
    setState({ time: `${hh}:${mm}`, phase, dawn: p > 0.86 });
  });

  return (
    <div className="night-clock" aria-hidden="true">
      <div className="nc-time">
        <span className="nc-moon">{state.dawn ? '☀' : '☾'}</span>
        {state.time}
      </div>
      <div className="nc-phase">{state.phase}</div>
    </div>
  );
}
