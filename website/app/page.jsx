import HomeShell from '../components/HomeShell.jsx';
import Hero from '../components/Hero.jsx';
import Compare from '../components/Compare.jsx';
import Timeline from '../components/Timeline.jsx';
import Agents from '../components/Agents.jsx';
import Contract from '../components/Contract.jsx';
import Dashboard from '../components/Dashboard.jsx';
import Usage from '../components/Usage.jsx';
import Prompts from '../components/Prompts.jsx';
import Guards from '../components/Guards.jsx';
import Commands from '../components/Commands.jsx';
import Faq from '../components/Faq.jsx';
import Footer from '../components/Footer.jsx';
import { FAQ } from '../lib/faq-data.jsx';
import { JsonLd, webSite, softwareApplication, faqPage } from '../lib/jsonld.js';
import { readChangelog } from '../lib/changelog.js';

export const metadata = {
  title: 'unsnooze — auto-resume Claude Code & Codex when the usage limit resets',
  description:
    'Hit the Claude Code 5-hour or weekly usage limit overnight? unsnooze tracks every limit-stopped AI coding session — Claude Code, Codex CLI, Grok, Qwen, Kimi, OpenCode, Antigravity — wakes each one in tmux or Zellij the moment the limit resets, and starts queued prompts as fresh sessions.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'unsnooze — while you sleep, the work continues',
    description:
      'Wakes every limit-stopped AI coding session the moment the usage limit resets. npm install -g unsnooze',
    url: '/',
  },
};

export default async function Home() {
  // Newest shipped version, same npm-cross-checked source the changelog uses.
  const [latest] = await readChangelog();
  return (
    <>
      <JsonLd data={webSite()} />
      <JsonLd data={softwareApplication()} />
      <JsonLd data={faqPage(FAQ)} />
      <HomeShell>
        <Hero version={latest?.version} />
        <Compare />
        <Timeline />
        <Agents />
        <Contract />
        <Dashboard />
        <Usage />
        <Prompts />
        <Guards />
        <Commands />
        <Faq />
        <Footer />
      </HomeShell>
    </>
  );
}
