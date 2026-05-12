import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getAimuxDir } from './paths.js';

export interface SessionHistoryEntry {
  sessionId: string;
  profile: string;
  lastUsedAtMs: number;
}

interface SessionHistoryFile {
  version: 1;
  entries: SessionHistoryEntry[];
}

export function getSessionHistoryPath(): string {
  return join(getAimuxDir(), 'session-history.json');
}

export function loadSessionHistory(): Map<string, SessionHistoryEntry> {
  const path = getSessionHistoryPath();
  const map = new Map<string, SessionHistoryEntry>();
  if (!existsSync(path)) return map;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as SessionHistoryFile;
    if (!Array.isArray(raw.entries)) return map;
    for (const e of raw.entries) {
      if (
        typeof e?.sessionId === 'string' &&
        typeof e?.profile === 'string' &&
        typeof e?.lastUsedAtMs === 'number'
      ) {
        map.set(e.sessionId, e);
      }
    }
  } catch {
    // ignore parse errors
  }
  return map;
}

export function saveSessionHistory(map: Map<string, SessionHistoryEntry>): void {
  const path = getSessionHistoryPath();
  mkdirSync(dirname(path), { recursive: true });
  const data: SessionHistoryFile = {
    version: 1,
    entries: Array.from(map.values()),
  };
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

export function recordSessionUsage(
  sessionId: string,
  profile: string,
  history?: Map<string, SessionHistoryEntry>,
): Map<string, SessionHistoryEntry> {
  const map = history ?? loadSessionHistory();
  map.set(sessionId, { sessionId, profile, lastUsedAtMs: Date.now() });
  try {
    saveSessionHistory(map);
  } catch {
    // best-effort
  }
  return map;
}
