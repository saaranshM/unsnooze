import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { Logo } from './Logo.js';
import { theme } from './theme.js';
import { StatusTab } from './tabs/StatusTab.js';
import { UsageTab } from './tabs/UsageTab.js';
import { SessionsTab } from './tabs/SessionsTab.js';
import { DoctorTab } from './tabs/DoctorTab.js';
import { LogsTab } from './tabs/LogsTab.js';
import { FleetTab } from './tabs/FleetTab.js';
import {
  loadStatusSnapshot,
  loadUsageSnapshot,
  loadSessionsSnapshot,
  loadDoctorSnapshot,
  loadLogsSnapshot,
  loadFleetSnapshot,
  flattenFleetStopped,
} from './data.js';
import { TAGLINE } from './mark.js';
import { MouseProvider, useMouse, useMouseWheel, Clickable } from './mouse.js';
import { isMouseNoise } from './mouse-protocol.js';
import { remoteAction } from '../fleet.js';

const h = React.createElement;

const TABS = [
  { id: 'status', label: 'Status', key: '1' },
  { id: 'usage', label: 'Usage', key: '2' },
  { id: 'sessions', label: 'Sessions', key: '3' },
  { id: 'doctor', label: 'Doctor', key: '4' },
  { id: 'logs', label: 'Logs', key: '5' },
  { id: 'fleet', label: 'Fleet', key: '6' },
];

const HELP_ROWS = [
  ['1–6', 'switch tab'],
  ['tab / shift-tab', 'next / prev tab'],
  ['j k / ↓ ↑', 'move selection'],
  ['r', 'refresh now'],
  ['R / C', 'fleet: resume / cancel selected remote session'],
  ['m', 'toggle mouse (click tabs/rows, wheel scroll)'],
  ['shift+click', 'select text while mouse is on (Option in iTerm2)'],
  ['?', 'toggle this help'],
  ['q', 'quit'],
];

function TabRow({ active, onSelect }) {
  return h(Box, { flexDirection: 'row' },
    ...TABS.map((t, i) =>
      h(Clickable, { key: t.id, onClick: () => onSelect(i), flexDirection: 'row' },
        h(Text, { color: i === active ? theme.accent : theme.muted, bold: i === active },
          ` ${t.key} `),
        h(Text, {
          color: i === active ? 'black' : theme.muted,
          backgroundColor: i === active ? theme.accent : undefined,
          bold: i === active,
        }, `${t.label}`),
        h(Text, null, '  '),
      ),
    ),
  );
}

function HelpOverlay({ cols, rows }) {
  const w = 40;
  const hgt = HELP_ROWS.length + 4;
  return h(Box, {
    position: 'absolute',
    top: Math.max(1, Math.floor((rows - hgt) / 2)),
    left: Math.max(1, Math.floor((cols - w) / 2)),
    width: w,
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor: theme.accent,
    paddingX: 2,
    paddingY: 1,
  },
    h(Text, { color: theme.accent, bold: true }, 'keys'),
    ...HELP_ROWS.map(([k, desc], i) =>
      h(Text, { key: i },
        h(Text, { color: theme.bright }, k.padEnd(17)),
        h(Text, { color: theme.muted }, desc),
      ),
    ),
  );
}

function Dashboard({ initialTab = 'status' } = {}) {
  const { exit } = useApp();
  const { columns, rows: winRows } = useWindowSize();
  const cols = columns || process.stdout.columns || 80;
  const rows = winRows || process.stdout.rows || 24;

  const startIdx = Math.max(0, TABS.findIndex(t => t.id === initialTab));
  const [tab, setTab] = useState(startIdx >= 0 ? startIdx : 0);
  const [selected, setSelected] = useState(0);
  const [logScroll, setLogScroll] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(Date.now());
  const [nowTick, setNowTick] = useState(Date.now());
  const [statusData, setStatusData] = useState(null);
  const [usageData, setUsageData] = useState(null);
  const [sessionsData, setSessionsData] = useState(null);
  const [doctorData, setDoctorData] = useState(null);
  const [logsData, setLogsData] = useState(null);
  const [fleetData, setFleetData] = useState(null);
  const [usageBusy, setUsageBusy] = useState(false);
  const [fleetBusy, setFleetBusy] = useState(false);
  const [err, setErr] = useState(null);
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const refreshStatus = useCallback(() => {
    try {
      setStatusData(loadStatusSnapshot());
      setLastRefresh(Date.now());
      setErr(null);
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  const refreshUsage = useCallback(async () => {
    setUsageBusy(true);
    try {
      setUsageData(await loadUsageSnapshot());
      setLastRefresh(Date.now());
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setUsageBusy(false);
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      setSessionsData(await loadSessionsSnapshot());
      setLastRefresh(Date.now());
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  const refreshDoctor = useCallback(async () => {
    try {
      setDoctorData(await loadDoctorSnapshot());
      setLastRefresh(Date.now());
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  const refreshLogs = useCallback(() => {
    try {
      setLogsData(loadLogsSnapshot({ maxLines: 200 }));
      setLastRefresh(Date.now());
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  // ssh fan-out — timeout-bounded per host inside fetchFleet, but still a
  // real network round trip. Awaited like loadUsageSnapshot; a busy flag
  // keeps the header honest without blocking other tabs (the interval below
  // only fires this on the fleet tab, every 15 ticks, or on-demand via `r`).
  const refreshFleet = useCallback(async () => {
    setFleetBusy(true);
    try {
      setFleetData(await loadFleetSnapshot());
      setLastRefresh(Date.now());
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setFleetBusy(false);
    }
  }, []);

  const refreshActive = useCallback(() => {
    refreshStatus();
    const id = TABS[tabRef.current]?.id;
    if (id === 'usage') refreshUsage();
    else if (id === 'sessions') refreshSessions();
    else if (id === 'doctor') refreshDoctor();
    else if (id === 'logs') refreshLogs();
    else if (id === 'fleet') refreshFleet();
  }, [refreshStatus, refreshUsage, refreshSessions, refreshDoctor, refreshLogs, refreshFleet]);

  useEffect(() => {
    refreshStatus();
    const id = TABS[tab]?.id;
    if (id === 'usage') refreshUsage();
    else if (id === 'sessions') refreshSessions();
    else if (id === 'doctor') refreshDoctor();
    else if (id === 'logs') refreshLogs();
    else if (id === 'fleet') refreshFleet();
    setSelected(0);
    setLogScroll(0);
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      setNowTick(Date.now());
      refreshStatus();
      const tid = TABS[tabRef.current]?.id;
      if (tid === 'logs' && n % 2 === 0) refreshLogs();
      if (tid === 'usage' && n % 5 === 0) refreshUsage();
      if (tid === 'sessions' && n % 3 === 0) refreshSessions();
      if (tid === 'fleet' && n % 15 === 0) refreshFleet();
    }, 1000);
    return () => clearInterval(id);
  }, [refreshStatus, refreshUsage, refreshSessions, refreshLogs, refreshFleet]);

  const mouse = useMouse();

  // Fire-and-forget: remote resume/cancel act on marks only (the remote's
  // own daemon does the typing under its own gates — see src/fleet.js).
  // Result surfaces in the header error slot like any other dashboard error.
  const handleFleetAction = useCallback((verb) => {
    const rows = flattenFleetStopped(fleetData);
    if (rows.length === 0) return;
    const row = rows[Math.min(selected, rows.length - 1)];
    if (!row) return;
    const { host, dest, entry, session } = row;
    const id8 = session.key ? session.key.slice(0, 8) : (session.sessionId || '').slice(0, 8);
    // Prefer the full host descriptor (carries auth/source/etc) so a
    // password-auth host resumed/cancelled from the dashboard actually uses
    // its configured auth instead of silently falling back to key auth —
    // a bare dest string loses those fields.
    remoteAction(host, entry || dest, verb, session.key)
      .then((res) => {
        setErr(res.ok
          ? `fleet: ${verb} ${host}/${id8} ok`
          : `fleet: ${verb} ${host}/${id8} failed — ${res.error}`);
      })
      .catch((e) => setErr(`fleet: ${verb} ${host}/${id8} failed — ${e.message}`));
  }, [fleetData, selected]);

  useInput((input, key) => {
    if (isMouseNoise(input)) return;   // leaked SGR fragments are not keys
    if (input === 'm') { mouse.toggle(); return; }
    if (input === 'q') { exit(); return; }
    if (input === '?') { setShowHelp(s => !s); return; }
    if (key.escape && showHelp) { setShowHelp(false); return; }
    if (input === 'r') { refreshActive(); return; }
    if (key.tab) {
      setTab(t => (key.shift ? (t + TABS.length - 1) % TABS.length : (t + 1) % TABS.length));
      return;
    }
    if (input >= '1' && input <= '6') { setTab(Number(input) - 1); return; }
    if (TABS[tabRef.current]?.id === 'fleet' && input === 'R') { handleFleetAction('resume'); return; }
    if (TABS[tabRef.current]?.id === 'fleet' && input === 'C') { handleFleetAction('cancel'); return; }
    if (input === 'j' || key.downArrow) { setSelected(s => s + 1); return; }
    if (input === 'k' || key.upArrow) { setSelected(s => Math.max(0, s - 1)); }
  });

  useMouseWheel((ev) => {
    if (!ev.wheel) return;
    const id = TABS[tabRef.current]?.id;
    if (id === 'status' || id === 'sessions' || id === 'fleet') {
      if (ev.wheel === 'down') setSelected(s => s + 1);
      else setSelected(s => Math.max(0, s - 1));
    } else if (id === 'logs') {
      setLogScroll(s => ev.wheel === 'up' ? s + 3 : Math.max(0, s - 3));
    }
  });

  const listLen = TABS[tab]?.id === 'status'
    ? (statusData?.sessions?.length || 0)
    : TABS[tab]?.id === 'sessions'
      ? (sessionsData?.length || 0)
      : TABS[tab]?.id === 'fleet'
        ? flattenFleetStopped(fleetData).length
        : 0;
  const sel = listLen ? Math.min(selected, listLen - 1) : 0;
  const ago = Math.max(0, Math.round((nowTick - lastRefresh) / 1000));
  const active = TABS[tab];
  const statusWithNow = statusData ? { ...statusData, now: nowTick } : null;

  // Floor test: full 6-row mark needs vertical room; short terminals get the
  // one-line compact mark so data keeps the space.
  const fullLogo = rows >= 24;
  // Wordmark: chevron(8) + z(10) + UNSNOOZE(71) + right meta(~26) — needs width.
  const showWordmark = fullLogo && cols >= 118;
  const headerRows = (fullLogo ? 6 : 1) + 1 + (showWordmark ? 1 : 0); // + margin + tagline
  const bodyRows = Math.max(3, rows - headerRows - 4); // tab row + rules + footer

  let main;
  switch (active?.id) {
    case 'usage': main = h(UsageTab, { data: usageData }); break;
    case 'sessions': main = h(SessionsTab, { data: sessionsData, selected: sel, onSelect: setSelected }); break;
    case 'doctor': main = h(DoctorTab, { data: doctorData }); break;
    case 'logs': main = h(LogsTab, { data: logsData, maxRows: bodyRows - 2, scroll: logScroll }); break;
    case 'fleet': main = h(FleetTab, { data: fleetData, selected: sel, onSelect: setSelected }); break;
    default: main = h(StatusTab, { data: statusWithNow, selected: sel, onSelect: setSelected });
  }

  const daemon = statusData?.daemonRunning
    ? h(Text, null, h(Text, { color: theme.ok }, '● '), h(Text, { color: theme.muted }, `daemon ${statusData.resumerPid}`))
    : h(Text, null, h(Text, { color: theme.crit }, '○ '), h(Text, { color: theme.muted }, 'daemon off'));

  return h(Box, {
    flexDirection: 'column',
    width: cols,
    height: rows,
    paddingX: 1,
  },
    // Header: animated mark + live meta (breathing room above the tab row)
    h(Box, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: showWordmark ? 0 : 1 },
      h(Logo, { compact: !fullLogo, wordmark: showWordmark }),
      h(Box, { flexDirection: 'column', alignItems: 'flex-end' },
        // The big wordmark says it already — keep the title only when hidden
        showWordmark ? null : h(Text, null,
          h(Text, { color: theme.accent, bold: true }, 'unsnooze'),
          h(Text, { color: theme.muted }, '  live dashboard'),
        ),
        daemon,
        h(Text, { color: theme.muted, dimColor: true },
          `refreshed ${ago}s ago${usageBusy || fleetBusy ? ' · scanning…' : ''}`),
      ),
    ),
    showWordmark
      ? h(Box, { marginBottom: 1 },
        h(Text, { color: theme.accent, bold: true }, '❯ '),
        h(Text, { color: theme.muted }, TAGLINE.slice(2)),
      )
      : null,
    // Tab row over a dim rule
    h(TabRow, { active: tab, onSelect: setTab }),
    h(Text, { color: theme.muted, dimColor: true }, '─'.repeat(Math.max(0, cols - 2))),
    // Body
    h(Box, { flexDirection: 'column', flexGrow: 1, paddingX: 1, paddingTop: 1 },
      err ? h(Text, { color: theme.crit }, `error: ${err}`) : null,
      main,
    ),
    // Footer: context keys + brand mark
    h(Text, { color: theme.muted, dimColor: true }, '─'.repeat(Math.max(0, cols - 2))),
    h(Box, { flexDirection: 'row', justifyContent: 'space-between' },
      h(Box, { flexDirection: 'row' },
        h(Text, { color: theme.muted }, ' 1-6 tabs · j/k move · '),
        h(Clickable, { onClick: refreshActive }, h(Text, { color: theme.muted }, 'r refresh')),
        h(Text, { color: theme.muted }, ' · '),
        h(Clickable, { onClick: () => setShowHelp(s => !s) },
          h(Text, { color: theme.muted }, h(Text, { color: theme.bright }, '?'), ' help')),
        h(Text, { color: theme.muted }, ' · '),
        h(Clickable, { onClick: () => mouse.toggle() },
          h(Text, { color: theme.muted }, `m mouse ${mouse.enabled ? '✓' : '✗'}`)),
        h(Text, { color: theme.muted }, ' · '),
        h(Clickable, { onClick: exit }, h(Text, { color: theme.muted }, 'q quit')),
      ),
      h(Text, { color: theme.accent, bold: true }, '❯ '),
    ),
    showHelp
      ? h(Clickable, {
        onClick: () => setShowHelp(false),
        position: 'absolute', top: 0, left: 0, width: cols, height: rows,
      }, h(HelpOverlay, { cols, rows }))
      : null,
  );
}

export function App({ initialTab = 'status', mouseEnabled = true } = {}) {
  return h(MouseProvider, { initialEnabled: mouseEnabled },
    h(Dashboard, { initialTab }));
}
