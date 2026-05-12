import { useState, useMemo, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { AimuxConfig } from '../types/index.js';
import { unifyAllSessions, type UnifiedSession } from '../core/unifiedSessions.js';
import { formatRelativeTime, shortenPath, type SessionState } from '../core/sessions.js';
import { loadActiveProfile, saveActiveProfile } from '../core/activeProfile.js';

export type AgentsAction =
  | { type: 'exit' }
  | { type: 'attach'; profile: string; sessionId: string; cwd: string; isBackground: boolean; bgShort?: string }
  | { type: 'dispatch'; profile: string; prompt: string }
  | { type: 'stop'; profile: string; short: string };

interface Props {
  config: AimuxConfig;
  onAction: (action: AgentsAction) => void;
}

type ViewMode = 'list' | 'dispatch' | 'filter' | 'help' | 'pickActiveProfile' | 'pickAttachProfile';
type GroupMode = 'recency' | 'cwd' | 'state' | 'flat';

interface SessionRow {
  kind: 'session';
  session: UnifiedSession;
}

interface GroupHeader {
  kind: 'header';
  label: string;
  count: number;
  groupKey: string;
}

type DisplayRow = SessionRow | GroupHeader;

const STATE_ICON: Record<SessionState, string> = {
  working: '✽',
  needs_input: '⚠',
  idle: '∙',
  done: '✻',
  failed: '✗',
  stopped: '∙',
  unknown: '·',
};

const STATE_COLOR: Record<SessionState, string | undefined> = {
  working: 'cyan',
  needs_input: 'yellow',
  idle: 'gray',
  done: 'green',
  failed: 'red',
  stopped: 'gray',
  unknown: 'gray',
};

const STATE_LABEL: Record<SessionState, string> = {
  working: 'working',
  needs_input: 'needs input',
  idle: 'idle',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  unknown: '—',
};

const STATE_ORDER: SessionState[] = ['needs_input', 'working', 'idle', 'done', 'failed', 'stopped', 'unknown'];

function matchesFilter(s: UnifiedSession, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    s.name.toLowerCase().includes(q) ||
    s.intent.toLowerCase().includes(q) ||
    s.detail.toLowerCase().includes(q) ||
    s.cwd.toLowerCase().includes(q) ||
    s.state.toLowerCase().includes(q) ||
    (s.lastProfile?.toLowerCase().includes(q) ?? false) ||
    (s.bgProfile?.toLowerCase().includes(q) ?? false) ||
    s.short.toLowerCase().includes(q)
  );
}

function buildRows(
  sessions: UnifiedSession[],
  groupMode: GroupMode,
  collapsed: Set<string>,
  filter: string,
): DisplayRow[] {
  const filtered = sessions.filter((s) => matchesFilter(s, filter));

  if (groupMode === 'flat') {
    return filtered.map((s) => ({ kind: 'session', session: s }));
  }

  const groups = new Map<string, { label: string; sessions: UnifiedSession[] }>();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  for (const s of filtered) {
    let key: string;
    let label: string;
    if (groupMode === 'recency') {
      const age = now - s.updatedAtMs;
      if (age < DAY) {
        key = 'recent';
        label = 'Recent (last 24h)';
      } else if (age < 7 * DAY) {
        key = 'week';
        label = 'This week';
      } else {
        key = 'older';
        label = 'Older';
      }
    } else if (groupMode === 'cwd') {
      const cwd = s.cwd || '(no cwd)';
      key = `cwd:${cwd}`;
      label = shortenPath(cwd);
    } else {
      key = `state:${s.state}`;
      label = STATE_LABEL[s.state];
    }
    const arr = groups.get(key) ?? { label, sessions: [] };
    arr.sessions.push(s);
    groups.set(key, arr);
  }

  let orderedKeys: string[];
  if (groupMode === 'recency') {
    orderedKeys = ['recent', 'week', 'older'].filter((k) => groups.has(k));
  } else if (groupMode === 'state') {
    orderedKeys = STATE_ORDER.map((s) => `state:${s}`).filter((k) => groups.has(k));
  } else {
    orderedKeys = Array.from(groups.keys()).sort();
  }

  const rows: DisplayRow[] = [];
  for (const key of orderedKeys) {
    const g = groups.get(key)!;
    rows.push({ kind: 'header', label: g.label, count: g.sessions.length, groupKey: key });
    if (!collapsed.has(key)) {
      for (const s of g.sessions) rows.push({ kind: 'session', session: s });
    }
  }
  return rows;
}

function firstSessionIndex(rows: DisplayRow[]): number {
  const idx = rows.findIndex((r) => r.kind === 'session');
  return idx >= 0 ? Math.max(0, idx) : 0;
}

function findGroupKey(rows: DisplayRow[], idx: number): string | undefined {
  for (let i = idx; i >= 0; i--) {
    const r = rows[i];
    if (r.kind === 'header') return r.groupKey;
  }
  return undefined;
}

export function AgentsView({ config, onAction }: Props) {
  const { exit } = useApp();

  const nonSourceProfiles = useMemo(
    () => Object.keys(config.profiles).filter((n) => !config.profiles[n].is_source),
    [config],
  );
  const allProfiles = useMemo(() => Object.keys(config.profiles), [config]);

  const initialActive = useMemo(() => {
    const saved = loadActiveProfile();
    if (saved && config.profiles[saved]) return saved;
    return nonSourceProfiles[0] ?? allProfiles[0];
  }, [config, nonSourceProfiles, allProfiles]);

  const [activeProfile, setActiveProfile] = useState<string>(initialActive);
  const [windowDays, setWindowDays] = useState<number>(7);
  const [sessions, setSessions] = useState<UnifiedSession[]>(() =>
    unifyAllSessions(config, { windowDays: 7 }),
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [groupMode, setGroupMode] = useState<GroupMode>('recency');
  const [filter, setFilter] = useState('');
  const [filterDraft, setFilterDraft] = useState('');
  const [peekOpen, setPeekOpen] = useState(false);
  const [mode, setMode] = useState<ViewMode>('list');
  const [dispatchPrompt, setDispatchPrompt] = useState('');
  const [dispatchProfileDraft, setDispatchProfileDraft] = useState<string>(initialActive);
  const [profilePickerIdx, setProfilePickerIdx] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [viewportTop, setViewportTop] = useState(0);
  const VISIBLE_ROWS = 15;

  const visibleSessions = useMemo(() => {
    if (showAll || filter) return sessions;
    // Hide noise: very short sessions that look like dispatched system
    // tasks with no real interactive activity. Keep anything that's
    // currently working / needs input regardless of event count.
    return sessions.filter((s) => {
      if (s.state === 'working' || s.state === 'needs_input') return true;
      if (s.events >= 5) return true;
      return false;
    });
  }, [sessions, showAll, filter]);

  const rows = useMemo(
    () => buildRows(visibleSessions, groupMode, collapsed, filter),
    [visibleSessions, groupMode, collapsed, filter],
  );

  const [cursor, setCursor] = useState(() => firstSessionIndex(rows));

  useEffect(() => {
    if (rows.length === 0) {
      setCursor(0);
      setViewportTop(0);
      return;
    }
    if (cursor >= rows.length || rows[cursor]?.kind !== 'session') {
      setCursor(firstSessionIndex(rows));
    }
  }, [rows]);

  // Keep cursor inside the viewport window.
  useEffect(() => {
    if (cursor < viewportTop) {
      setViewportTop(cursor);
    } else if (cursor >= viewportTop + VISIBLE_ROWS) {
      setViewportTop(cursor - VISIBLE_ROWS + 1);
    }
  }, [cursor, viewportTop]);

  useEffect(() => {
    try {
      saveActiveProfile(activeProfile);
    } catch {
      // best-effort
    }
  }, [activeProfile]);

  const refresh = () => setSessions(unifyAllSessions(config, { windowDays }));

  const loadAllHistory = () => {
    setWindowDays(Infinity);
    setSessions(unifyAllSessions(config, { windowDays: Infinity }));
  };

  const moveCursor = (delta: number) => {
    if (rows.length === 0) return;
    let next = cursor;
    for (let step = 0; step < rows.length; step++) {
      next = (next + delta + rows.length) % rows.length;
      if (rows[next].kind === 'session') {
        setCursor(next);
        return;
      }
    }
  };

  const jumpToNextGroup = () => {
    for (let i = cursor + 1; i < rows.length; i++) {
      if (rows[i].kind === 'header') {
        for (let j = i + 1; j < rows.length; j++) {
          if (rows[j].kind === 'session') {
            setCursor(j);
            return;
          }
          if (rows[j].kind === 'header') break;
        }
      }
    }
    const first = firstSessionIndex(rows);
    if (first >= 0) setCursor(first);
  };

  const toggleCollapseAtCursor = () => {
    const row = rows[cursor];
    const key = row?.kind === 'header' ? row.groupKey : findGroupKey(rows, cursor);
    if (!key) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const currentRow = rows[cursor];
  const currentSession = currentRow?.kind === 'session' ? currentRow.session : undefined;

  const doAttach = (profile: string) => {
    if (!currentSession) return;
    onAction({
      type: 'attach',
      profile,
      sessionId: currentSession.sessionId,
      cwd: currentSession.cwd,
      isBackground: currentSession.isBackground,
      bgShort: currentSession.short,
    });
    exit();
  };

  useInput((input, key) => {
    if (mode === 'help') {
      if (key.escape || input === '?' || input === 'q') setMode('list');
      return;
    }

    if (mode === 'pickActiveProfile' || mode === 'pickAttachProfile') {
      if (key.escape) {
        setMode('list');
        return;
      }
      if (key.upArrow) {
        setProfilePickerIdx((i) => (i > 0 ? i - 1 : allProfiles.length - 1));
        return;
      }
      if (key.downArrow) {
        setProfilePickerIdx((i) => (i < allProfiles.length - 1 ? i + 1 : 0));
        return;
      }
      if (key.return) {
        const chosen = allProfiles[profilePickerIdx];
        if (mode === 'pickActiveProfile') {
          setActiveProfile(chosen);
          setMode('list');
        } else {
          setMode('list');
          doAttach(chosen);
        }
      }
      return;
    }

    if (mode === 'filter') {
      if (key.escape) {
        setMode('list');
        setFilterDraft(filter);
        return;
      }
      if (key.return) {
        setFilter(filterDraft);
        setMode('list');
        return;
      }
      if (key.backspace || key.delete) {
        setFilterDraft((p) => p.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFilterDraft((p) => p + input);
      }
      return;
    }

    if (mode === 'dispatch') {
      if (key.escape) {
        setMode('list');
        setDispatchPrompt('');
        return;
      }
      if (key.tab) {
        const targets = nonSourceProfiles.length > 0 ? nonSourceProfiles : allProfiles;
        const idx = targets.indexOf(dispatchProfileDraft);
        setDispatchProfileDraft(targets[(idx + 1) % targets.length]);
        return;
      }
      if (key.return) {
        if (dispatchPrompt.trim()) {
          onAction({
            type: 'dispatch',
            profile: dispatchProfileDraft,
            prompt: dispatchPrompt.trim(),
          });
          setDispatchPrompt('');
          setMode('list');
          exit();
        }
        return;
      }
      if (key.backspace || key.delete) {
        setDispatchPrompt((p) => p.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setDispatchPrompt((p) => p + input);
      }
      return;
    }

    if (key.upArrow) moveCursor(-1);
    else if (key.downArrow) moveCursor(1);
    else if (key.tab) jumpToNextGroup();
    else if (key.return || key.rightArrow) {
      if (currentSession) doAttach(activeProfile);
    } else if (input === ' ') {
      if (currentSession) setPeekOpen((v) => !v);
    } else if (input === 'n') {
      setDispatchProfileDraft(activeProfile);
      setMode('dispatch');
    } else if (input === 'P') {
      setProfilePickerIdx(Math.max(0, allProfiles.indexOf(activeProfile)));
      setMode('pickAttachProfile');
    } else if (input === 'p') {
      setProfilePickerIdx(Math.max(0, allProfiles.indexOf(activeProfile)));
      setMode('pickActiveProfile');
    } else if (input === 's') {
      if (currentSession?.isBackground && currentSession.bgProfile) {
        onAction({ type: 'stop', profile: currentSession.bgProfile, short: currentSession.short });
        exit();
      }
    } else if (input === 'g') {
      setGroupMode((m) =>
        m === 'recency' ? 'cwd' : m === 'cwd' ? 'state' : m === 'state' ? 'flat' : 'recency',
      );
      setCollapsed(new Set());
    } else if (input === 'c') {
      toggleCollapseAtCursor();
    } else if (input === 'r') {
      refresh();
    } else if (input === 'L') {
      loadAllHistory();
    } else if (input === 'a') {
      setShowAll((v) => !v);
    } else if (input === '/') {
      setFilterDraft(filter);
      setMode('filter');
    } else if (input === '?') {
      setMode('help');
    } else if (key.escape || input === 'q') {
      onAction({ type: 'exit' });
      exit();
    }
  });

  if (mode === 'help') return <HelpOverlay activeProfile={activeProfile} />;
  if (mode === 'pickActiveProfile' || mode === 'pickAttachProfile') {
    return (
      <ProfilePickerModal
        title={mode === 'pickActiveProfile' ? 'Change active profile' : `Attach "${currentSession?.name ?? ''}" via…`}
        profiles={allProfiles}
        config={config}
        cursor={profilePickerIdx}
        activeProfile={activeProfile}
        sessionLastProfile={currentSession?.lastProfile}
      />
    );
  }
  if (mode === 'dispatch') {
    return (
      <DispatchModal
        profile={dispatchProfileDraft}
        prompt={dispatchPrompt}
        targets={nonSourceProfiles.length > 0 ? nonSourceProfiles : allProfiles}
      />
    );
  }

  const now = Date.now();
  const home = process.env.HOME ?? '';

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color="cyan">aimux agents</Text>
          <Text dimColor>
            {' · '}
            {sessions.length} sessions · group: {groupMode}
            {Number.isFinite(windowDays) ? ` · window: ${windowDays}d` : ' · window: all'}
            {filter ? ` · filter: ${filter}` : ''}
          </Text>
        </Text>
        <Text>
          active: <Text bold color="magenta">★ {activeProfile}</Text>
          <Text dimColor>  [p] change · [Shift+P] one-off · [?] help</Text>
        </Text>
      </Box>

      {mode === 'filter' && (
        <Box>
          <Text color="yellow">/ </Text>
          <Text>{filterDraft}</Text>
          <Text color="cyan">▏</Text>
        </Box>
      )}

      <Text> </Text>

      {viewportTop > 0 && (
        <Text dimColor>▲ {viewportTop} more above (↑ to scroll)</Text>
      )}

      {rows.slice(viewportTop, viewportTop + VISIBLE_ROWS).map((row, relIdx) => {
        const idx = viewportTop + relIdx;
        if (row.kind === 'header') {
          const arrow = collapsed.has(row.groupKey) ? '▶' : '▼';
          return (
            <Box key={`h:${row.groupKey}`} gap={1}>
              <Text color="magenta" bold>
                {arrow} {row.label} ({row.count})
              </Text>
            </Box>
          );
        }

        const isSel = idx === cursor;
        const s = row.session;
        const icon = STATE_ICON[s.state];
        const color = STATE_COLOR[s.state];
        const age = formatRelativeTime(s.updatedAtMs, now);
        const cwd = shortenPath(s.cwd, home);
        const detail = s.detail || s.intent || '';
        const lastProfile = s.lastProfile ?? s.bgProfile;
        const bgTag = s.isBackground ? '[bg]' : '';

        return (
          <Box key={`s:${s.sessionId}`} flexDirection="column">
            <Box gap={1}>
              <Text color={isSel ? 'cyan' : undefined}>{isSel ? '❯' : ' '}</Text>
              <Text color={color}>{icon}</Text>
              <Box width={32}>
                <Text bold={isSel} wrap="truncate">{s.name}</Text>
              </Box>
              <Box width={22}>
                <Text dimColor wrap="truncate">{cwd}</Text>
              </Box>
              <Box width={6}>
                <Text dimColor>{age}</Text>
              </Box>
              <Box width={11}>
                <Text color={color}>{STATE_LABEL[s.state]}</Text>
              </Box>
              <Box width={4}>
                <Text dimColor>{bgTag}</Text>
              </Box>
              {lastProfile && (
                <Text dimColor>last: <Text color="yellow">{lastProfile}</Text></Text>
              )}
            </Box>
            {isSel && peekOpen && detail && (
              <Box marginLeft={4} flexDirection="column">
                <Text dimColor wrap="wrap">{detail}</Text>
                {s.intent && s.intent !== detail && (
                  <Text dimColor>↪ intent: {s.intent.slice(0, 200)}</Text>
                )}
              </Box>
            )}
          </Box>
        );
      })}

      {(() => {
        const remaining = Math.max(0, rows.length - viewportTop - VISIBLE_ROWS);
        return remaining > 0 ? (
          <Text dimColor>▼ {remaining} more below (↓ to scroll)</Text>
        ) : null;
      })()}

      {rows.length === 0 && (
        <Text dimColor>
          {filter
            ? `No sessions match "${filter}". Press / to edit, Esc to clear.`
            : sessions.length > 0 && !showAll
              ? `Noise hidden (${sessions.length} total). Press [a] to show all.`
              : 'No sessions yet. Press [n] to dispatch one.'}
        </Text>
      )}

      <Text> </Text>
      <Box>
        <Text dimColor>
          [↑↓] nav  [→/⏎] attach via [{activeProfile}]  [Shift+P] one-off  [␣] peek  [n] new  [s] stop  [g] group  [a] {showAll ? 'hide noise' : 'show all'}  [L] load older  [c] collapse  [/] filter  [r] refresh  [?] help  [q] quit
        </Text>
      </Box>
    </Box>
  );
}

function HelpOverlay({ activeProfile }: { activeProfile: string }) {
  const rows: Array<[string, string]> = [
    ['↑ / ↓', 'navigate sessions'],
    ['→ / Enter', `attach via active profile (${activeProfile}) — uses claude --resume`],
    ['Shift+P', 'attach via different profile (one-off override)'],
    ['p', 'change active profile (persistent across runs)'],
    ['Space', 'toggle peek for selected session (detail/intent)'],
    ['n', 'dispatch new background session (Tab cycles target profile)'],
    ['s', 'stop selected session (background only)'],
    ['g', 'cycle group mode: recency → cwd → state → flat'],
    ['c', 'collapse/expand group at cursor'],
    ['Tab', 'jump to next group'],
    ['/', 'filter (name/cwd/intent/state/profile)'],
    ['r', 'refresh now'],
    ['?', 'this help'],
    ['q / Esc', 'exit'],
  ];
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">aimux agents — keyboard shortcuts</Text>
      <Text dimColor>active profile: {activeProfile}</Text>
      <Text> </Text>
      {rows.map(([k, d]) => (
        <Box key={k} gap={2}>
          <Box width={14}><Text color="yellow">{k}</Text></Box>
          <Text>{d}</Text>
        </Box>
      ))}
      <Text> </Text>
      <Text dimColor>Press ? or Esc to close</Text>
    </Box>
  );
}

function ProfilePickerModal({
  title,
  profiles,
  config,
  cursor,
  activeProfile,
  sessionLastProfile,
}: {
  title: string;
  profiles: string[];
  config: AimuxConfig;
  cursor: number;
  activeProfile: string;
  sessionLastProfile?: string;
}) {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">{title}</Text>
      <Text> </Text>
      {profiles.map((name, i) => {
        const p = config.profiles[name];
        const sel = i === cursor;
        const tags: string[] = [];
        if (p.is_source) tags.push('source');
        if (p.model) tags.push(p.model);
        if (name === activeProfile) tags.push('current active');
        if (name === sessionLastProfile) tags.push('last used by this session');
        return (
          <Box key={name} gap={1}>
            <Text color={sel ? 'cyan' : undefined} bold={sel}>
              {sel ? '❯' : ' '} {name}
            </Text>
            {tags.length > 0 && <Text dimColor>[{tags.join(' · ')}]</Text>}
          </Box>
        );
      })}
      <Text> </Text>
      <Text dimColor>↑↓ navigate · Enter select · Esc cancel</Text>
    </Box>
  );
}

function DispatchModal({
  profile,
  prompt,
  targets,
}: {
  profile: string;
  prompt: string;
  targets: string[];
}) {
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">Dispatch new background session</Text>
      <Text> </Text>
      <Box>
        <Text>Profile: </Text>
        <Text color="magenta" bold>{profile}</Text>
        <Text dimColor>   (Tab to switch — {targets.join(', ')})</Text>
      </Box>
      <Text> </Text>
      <Box>
        <Text>Prompt: </Text>
        <Text>{prompt}</Text>
        <Text color="cyan">▏</Text>
      </Box>
      <Text> </Text>
      <Text dimColor>Enter to dispatch · Esc to cancel</Text>
    </Box>
  );
}
