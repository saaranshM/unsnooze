import HomeShell from '../components/HomeShell.jsx';
import Hero from '../components/Hero.jsx';
import Compare from '../components/Compare.jsx';
import Timeline from '../components/Timeline.jsx';
import Agents from '../components/Agents.jsx';
import Contract from '../components/Contract.jsx';
import Dashboard from '../components/Dashboard.jsx';
import Usage from '../components/Usage.jsx';
import Guards from '../components/Guards.jsx';
import Commands from '../components/Commands.jsx';
import Faq from '../components/Faq.jsx';
import Footer from '../components/Footer.jsx';
import { FAQ } from '../lib/faq-data.jsx';
import { JsonLd, webSite, softwareApplication, faqPage } from '../lib/jsonld.js';

export const metadata = {
  title: 'unsnooze — auto-resume Claude Code & Codex when the usage limit resets',
  description:
    'Hit the Claude Code 5-hour or weekly usage limit overnight? unsnooze tracks every limit-stopped AI coding session — Claude Code, Codex CLI, Grok, Qwen, Kimi, OpenCode, Antigravity — and wakes each one in tmux or Zellij the moment the limit resets.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'unsnooze — while you sleep, the work continues',
    description:
      'Wakes every limit-stopped AI coding session the moment the usage limit resets. npm install -g unsnooze',
    url: '/',
  },
};

export default function Home() {
  return (
    <>
      <JsonLd data={webSite()} />
      <JsonLd data={softwareApplication()} />
      <JsonLd data={faqPage(FAQ)} />
      <HomeShell>
        <Hero />
        <Compare />
        <Timeline />
        <Agents />
        <Contract />
        <Dashboard />
        <Usage />
        <Guards />
        <Commands />
        <Faq />
        <Footer />
      </HomeShell>
    </>
  );
}
