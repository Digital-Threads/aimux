import { useState, useMemo, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { AimuxConfig } from '../types/index.js';
import {
  listAllSessions,
  formatRelativeTime,
  shortenPath,
  type SessionInfo,
  type SessionState,
} from '../core/sessions.js';

export type AgentsAction =
  | { type: 'exit' }
  | { type: 'attach'; profile: string; short: string }
  | { type: 'dispatch'; profile: string; prompt: string }
  | { type: 'stop'; profile: string; short: string };

interface Props {
  config: AimuxConfig;
  onAction: (action: AgentsAction) => void;
}

interface Row {
  kind: 'session';
  profile: string;
  session: SessionInfo;
  groupIndex: number;
}

interface HeaderRow {
  kind: 'header';
  profile: string;
  count: number;
  isDefault: boolean;
}

type DisplayRow = Row | HeaderRow;

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
  unknown: 'unknown',
};

function buildRows(
  sessionsByProfile: Map<string, SessionInfo[]>,
  collapsed: Set<string>,
  defaultProfile: string | undefined,
): DisplayRow[] {
  const rows: DisplayRow[] = [];
  for (const [profile, sessions] of sessionsByProfile) {
    rows.push({
      kind: 'header',
      profile,
      count: sessions.length,
      isDefault: profile === defaultProfile,
    });
    if (!collapsed.has(profile)) {
      sessions.forEach((session, i) => {
        rows.push({ kind: 'session', profile, session, groupIndex: i });
      });
    }
  }
  return rows;
}

function firstSessionIndex(rows: DisplayRow[]): number {
  const idx = rows.findIndex((r) => r.kind === 'session');
  return idx >= 0 ? idx : 0;
}

export function AgentsView({ config, onAction }: Props) {
  const { exit } = useApp();
  const defaultProfile = useMemo(() => {
    const names = Object.keys(config.profiles);
    return names.find((n) => !config.profiles[n].is_source) ?? names[0];
  }, [config]);

  const [sessionsByProfile, setSessionsByProfile] = useState(() => listAllSessions(config));
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [peekOpen, setPeekOpen] = useState(false);
  const [mode, setMode] = useState<'list' | 'dispatch' | 'help'>('list');
  const [dispatchProfile, setDispatchProfile] = useState(defaultProfile);
  const [dispatchPrompt, setDispatchPrompt] = useState('');

  const rows = useMemo(
    () => buildRows(sessionsByProfile, collapsed, defaultProfile),
    [sessionsByProfile, collapsed, defaultProfile],
  );

  const [cursor, setCursor] = useState(() => firstSessionIndex(rows));

  useEffect(() => {
    if (cursor >= rows.length) setCursor(Math.max(0, rows.length - 1));
  }, [rows.length]);

  const totalSessions = useMemo(
    () => Array.from(sessionsByProfile.values()).reduce((s, arr) => s + arr.length, 0),
    [sessionsByProfile],
  );

  const refresh = () => setSessionsByProfile(listAllSessions(config));

  const moveCursor = (delta: number) => {
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
        // first session inside that group
        for (let j = i + 1; j < rows.length; j++) {
          if (rows[j].kind === 'session') {
            setCursor(j);
            return;
          }
          if (rows[j].kind === 'header') break;
        }
      }
    }
    // wrap
    const first = firstSessionIndex(rows);
    if (first >= 0) setCursor(first);
  };

  const toggleCollapseAtCursor = () => {
    const row = rows[cursor];
    const targetProfile = row?.profile;
    if (!targetProfile) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(targetProfile)) next.delete(targetProfile);
      else next.add(targetProfile);
      return next;
    });
  };

  const currentRow = rows[cursor];
  const currentSession = currentRow?.kind === 'session' ? currentRow.session : undefined;
  const currentProfile = currentRow?.profile;

  useInput((input, key) => {
    if (mode === 'help') {
      if (key.escape || input === '?' || input === 'q') setMode('list');
      return;
    }

    if (mode === 'dispatch') {
      if (key.escape) {
        setMode('list');
        setDispatchPrompt('');
        return;
      }
      if (key.tab) {
        const names = Object.keys(config.profiles).filter((n) => !config.profiles[n].is_source);
        const idx = names.indexOf(dispatchProfile ?? names[0]);
        setDispatchProfile(names[(idx + 1) % names.length]);
        return;
      }
      if (key.return) {
        if (dispatchPrompt.trim() && dispatchProfile) {
          onAction({ type: 'dispatch', profile: dispatchProfile, prompt: dispatchPrompt.trim() });
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
      if (currentSession && currentProfile) {
        onAction({ type: 'attach', profile: currentProfile, short: currentSession.short });
        exit();
      }
    } else if (input === ' ') {
      if (currentSession) setPeekOpen((v) => !v);
    } else if (input === 'n') {
      setMode('dispatch');
    } else if (input === 's') {
      if (currentSession && currentProfile) {
        onAction({ type: 'stop', profile: currentProfile, short: currentSession.short });
        exit();
      }
    } else if (input === 'c') {
      toggleCollapseAtCursor();
    } else if (input === 'r') {
      refresh();
    } else if (input === '?') {
      setMode('help');
    } else if (key.escape || input === 'q') {
      onAction({ type: 'exit' });
      exit();
    }
  });

  if (mode === 'help') return <HelpOverlay />;
  if (mode === 'dispatch') {
    return (
      <DispatchModal
        config={config}
        profile={dispatchProfile}
        prompt={dispatchPrompt}
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
          <Text dimColor> · {sessionsByProfile.size} profiles · {totalSessions} sessions</Text>
        </Text>
        <Text dimColor>? for help</Text>
      </Box>

      <Text> </Text>

      {rows.map((row, idx) => {
        const isSel = idx === cursor;
        if (row.kind === 'header') {
          const arrow = collapsed.has(row.profile) ? '▶' : '▼';
          return (
            <Box key={`h:${row.profile}`} gap={1}>
              <Text color="magenta" bold>
                {arrow} {row.profile} ({row.count})
              </Text>
              {row.isDefault && <Text color="yellow">★ default</Text>}
            </Box>
          );
        }

        const s = row.session;
        const icon = STATE_ICON[s.state];
        const color = STATE_COLOR[s.state];
        const age = formatRelativeTime(s.updatedAtMs, now);
        const cwd = shortenPath(s.cwd, home);
        const detail = s.detail || s.intent || '';

        return (
          <Box key={`s:${row.profile}:${s.short}`} flexDirection="column">
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
              <Text color={color}>{STATE_LABEL[s.state]}</Text>
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

      {rows.length === 0 && (
        <Text dimColor>No sessions yet. Press [n] to dispatch one.</Text>
      )}

      <Text> </Text>
      <Box>
        <Text dimColor>
          [↑↓] nav  [→/⏎] attach  [␣] peek  [n] new  [s] stop  [c] collapse  [Tab] next group  [r] refresh  [?] help  [q] quit
        </Text>
      </Box>
    </Box>
  );
}

function HelpOverlay() {
  const rows: Array<[string, string]> = [
    ['↑ / ↓', 'navigate between sessions'],
    ['→ / Enter', 'attach to selected session'],
    ['Space', 'toggle peek (show detail/intent)'],
    ['n', 'dispatch new background session'],
    ['s', 'stop selected session'],
    ['c', 'collapse/expand profile group at cursor'],
    ['Tab', 'jump to first session in next group'],
    ['r', 'refresh from disk'],
    ['?', 'this help'],
    ['q / Esc', 'exit'],
  ];
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">aimux agents — keyboard shortcuts</Text>
      <Text> </Text>
      {rows.map(([key, desc]) => (
        <Box key={key} gap={2}>
          <Box width={14}><Text color="yellow">{key}</Text></Box>
          <Text>{desc}</Text>
        </Box>
      ))}
      <Text> </Text>
      <Text dimColor>Press ? or Esc to close</Text>
    </Box>
  );
}

function DispatchModal({
  config,
  profile,
  prompt,
}: {
  config: AimuxConfig;
  profile: string | undefined;
  prompt: string;
}) {
  const usableProfiles = Object.keys(config.profiles).filter(
    (n) => !config.profiles[n].is_source,
  );
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold color="cyan">Dispatch new background session</Text>
      <Text> </Text>
      <Box>
        <Text>Profile: </Text>
        <Text color="magenta" bold>{profile ?? '(none)'}</Text>
        <Text dimColor>   (Tab to switch — available: {usableProfiles.join(', ')})</Text>
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
