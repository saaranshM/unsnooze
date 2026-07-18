'use client';

import { motion, useScroll, useTransform } from 'framer-motion';
import SiteNav from './SiteNav.jsx';
import NightClock from './NightClock.jsx';
import Celestial from './Celestial.jsx';

// Deterministic star field — same sky on every visit (and on the server).
const STARS = Array.from({ length: 42 }, (_, i) => {
  const rand = (n) => {
    const x = Math.sin(i * 127.1 + n * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  // Fixed-precision strings so the server-serialized styles hydrate cleanly.
  return {
    top: `${(rand(1) * 92).toFixed(2)}%`,
    left: `${(rand(2) * 98).toFixed(2)}%`,
    size: rand(3) > 0.75 ? '2px' : '1.4px',
    delay: `${(rand(4) * 4.5).toFixed(2)}s`,
  };
});

// Client wrapper for the home page: ambient sky layers, nav, night clock and
// the traveling moon. The page sections arrive as server-rendered children.
export default function HomeShell({ children }) {
  const { scrollYProgress } = useScroll();
  // Night → dawn: the warm glow rises as you scroll; the stars go out.
  const dawnOpacity = useTransform(scrollYProgress, [0, 0.5, 0.85, 1], [0, 0.05, 0.3, 1]);
  const starOpacity = useTransform(scrollYProgress, [0, 0.7, 0.95], [1, 0.8, 0]);

  return (
    <div id="app">
      <motion.div className="stars-layer" aria-hidden="true" style={{ opacity: starOpacity }}>
        {STARS.map((s, i) => (
          <span
            key={i}
            style={{
              top: s.top, left: s.left,
              width: s.size, height: s.size,
              animationDelay: s.delay,
            }}
          />
        ))}
      </motion.div>
      <motion.div className="dawn-layer" aria-hidden="true" style={{ opacity: dawnOpacity }} />
      <Celestial />

      <SiteNav />
      <NightClock />

      <main className="wrap" id="top">
        {children}
      </main>
    </div>
  );
}
