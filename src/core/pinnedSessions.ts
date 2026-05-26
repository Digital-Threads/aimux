import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getAimuxDir } from './paths.js';

interface PinnedFile {
  version: 1;
  sessions: string[];
}

export function getPinnedPath(): string {
  return join(getAimuxDir(), 'pinned-sessions.json');
}

export function loadPinned(): Set<string> {
  const path = getPinnedPath();
  if (!existsSync(path)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as PinnedFile;
    if (!raw || !Array.isArray(raw.sessions)) return new Set();
    return new Set(raw.sessions.filter((s) => typeof s === 'string'));
  } catch {
    return new Set();
  }
}

export function savePinned(pinned: Set<string>): void {
  const path = getPinnedPath();
  mkdirSync(dirname(path), { recursive: true });
  const data: PinnedFile = { version: 1, sessions: Array.from(pinned) };
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

export function togglePinned(sessionId: string): Set<string> {
  const pinned = loadPinned();
  if (pinned.has(sessionId)) {
    pinned.delete(sessionId);
  } else {
    pinned.add(sessionId);
  }
  savePinned(pinned);
  return pinned;
}
