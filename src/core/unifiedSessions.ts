import type { AimuxConfig } from '../types/index.js';
import { listAllSessions, type SessionState } from './sessions.js';
import { scanInteractiveSessions } from './sessionScanner.js';
import { loadSessionHistory, type SessionHistoryEntry } from './sessionHistory.js';
import { buildProfileSessionMap } from './profileSessionMap.js';

export interface UnifiedSession {
  sessionId: string;
  short: string;
  name: string;
  intent: string;
  cwd: string;
  cwdHashDir?: string;
  state: SessionState;
  detail: string;
  updatedAtMs: number;
  createdAtMs: number;
  events: number;
  /** Profile that owns the background supervisor entry for this session, if any. */
  bgProfile?: string;
  /** Last profile from which the session was launched/attached via aimux. */
  lastProfile?: string;
  isInteractive: boolean;
  isBackground: boolean;
}

function deriveName(intent: string, sessionId: string): string {
  if (intent) {
    const firstLine = intent.split('\n')[0].trim();
    if (firstLine) return firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine;
  }
  return `session-${sessionId.slice(0, 8)}`;
}

function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

export function unifyAllSessions(config: AimuxConfig): UnifiedSession[] {
  const interactive = scanInteractiveSessions(config);
  const bgByProfile = listAllSessions(config);
  const history = loadSessionHistory();
  const profileMap = buildProfileSessionMap(config);

  function resolveLastProfile(sessionId: string): string | undefined {
    // Explicit aimux tracking wins. Fallback to claude.json's lastSessionId
    // mapping so even pre-tracking sessions get attribution.
    const entry: SessionHistoryEntry | undefined = history.get(sessionId);
    if (entry) return entry.profile;
    return profileMap.get(sessionId)?.profile;
  }

  const bySessionId = new Map<string, UnifiedSession>();

  // Seed with interactive transcripts (canonical universe of sessions).
  for (const s of interactive) {
    bySessionId.set(s.sessionId, {
      sessionId: s.sessionId,
      short: shortId(s.sessionId),
      name: deriveName(s.intent, s.sessionId),
      intent: s.intent,
      cwd: s.cwd,
      cwdHashDir: s.cwdHashDir,
      state: 'unknown',
      detail: '',
      updatedAtMs: s.updatedAtMs,
      createdAtMs: s.createdAtMs,
      events: s.events,
      lastProfile: resolveLastProfile(s.sessionId),
      isInteractive: true,
      isBackground: false,
    });
  }

  // Augment with background sessions from any profile's jobs/state.json.
  for (const [profileName, sessions] of bgByProfile) {
    for (const bg of sessions) {
      const existing = bySessionId.get(bg.sessionId);
      if (existing) {
        existing.state = bg.state;
        existing.detail = bg.detail || existing.detail;
        existing.bgProfile = profileName;
        existing.isBackground = true;
        existing.updatedAtMs = Math.max(existing.updatedAtMs, bg.updatedAtMs);
        if (!existing.name || existing.name.startsWith('session-')) {
          existing.name = bg.name || existing.name;
        }
        if (!existing.intent) existing.intent = bg.intent;
        if (!existing.lastProfile) existing.lastProfile = profileName;
      } else {
        // Background session whose transcript isn't yet flushed to projects/
        bySessionId.set(bg.sessionId, {
          sessionId: bg.sessionId,
          short: bg.short || shortId(bg.sessionId),
          name: bg.name,
          intent: bg.intent,
          cwd: bg.cwd,
          state: bg.state,
          detail: bg.detail,
          updatedAtMs: bg.updatedAtMs,
          createdAtMs: bg.createdAt ? Date.parse(bg.createdAt) : bg.updatedAtMs,
          events: 0,
          bgProfile: profileName,
          lastProfile: resolveLastProfile(bg.sessionId) ?? profileName,
          isInteractive: false,
          isBackground: true,
        });
      }
    }
  }

  return Array.from(bySessionId.values()).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}
