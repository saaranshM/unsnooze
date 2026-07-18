'use client';

import { motion, useScroll, useTransform } from 'framer-motion';
import SiteNav from './SiteNav.jsx';
import NightClock from './NightClock.jsx';
import Celestial from './Celestial.jsx';
import Stars from './Stars.jsx';

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
        <Stars />
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
