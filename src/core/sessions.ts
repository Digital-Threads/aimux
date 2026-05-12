import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AimuxConfig } from '../types/index.js';
import { getProfile } from './config.js';
import { expandHome } from './paths.js';

export type SessionState =
  | 'working'
  | 'needs_input'
  | 'idle'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'unknown';

export interface SessionInfo {
  profile: string;
  short: string;
  sessionId: string;
  name: string;
  state: SessionState;
  detail: string;
  cwd: string;
  intent: string;
  createdAt: string;
  updatedAt: string;
  updatedAtMs: number;
  tempo?: string;
  inFlightTasks?: number;
  cliVersion?: string;
}

interface RawState {
  state?: string;
  detail?: string;
  tempo?: string;
  inFlight?: { tasks?: number };
  intent?: string;
  name?: string;
  sessionId?: string;
  daemonShort?: string;
  cliVersion?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
}

function normalizeState(s: string | undefined): SessionState {
  switch (s) {
    case 'working':
    case 'needs_input':
    case 'idle':
    case 'done':
    case 'failed':
    case 'stopped':
      return s;
    default:
      return 'unknown';
  }
}

export function listSessions(config: AimuxConfig, profileName: string): SessionInfo[] {
  const profile = getProfile(config, profileName);
  const profilePath = expandHome(profile.path);
  const jobsDir = join(profilePath, 'jobs');

  if (!existsSync(jobsDir)) return [];

  let entries: string[];
  try {
    entries = readdirSync(jobsDir);
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const short of entries) {
    if (short.startsWith('.') || short === 'pins.json' || short === 'dispatch') continue;
    const statePath = join(jobsDir, short, 'state.json');
    if (!existsSync(statePath)) continue;
    try {
      const raw = JSON.parse(readFileSync(statePath, 'utf-8')) as RawState;
      const updatedAtMs = raw.updatedAt
        ? Date.parse(raw.updatedAt)
        : statSync(statePath).mtimeMs;
      sessions.push({
        profile: profileName,
        short: raw.daemonShort ?? short,
        sessionId: raw.sessionId ?? '',
        name: raw.name ?? '(unnamed)',
        state: normalizeState(raw.state),
        detail: raw.detail ?? '',
        cwd: raw.cwd ?? '',
        intent: raw.intent ?? '',
        createdAt: raw.createdAt ?? '',
        updatedAt: raw.updatedAt ?? '',
        updatedAtMs,
        tempo: raw.tempo,
        inFlightTasks: raw.inFlight?.tasks,
        cliVersion: raw.cliVersion,
      });
    } catch {
      continue;
    }
  }

  sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return sessions;
}

export function listAllSessions(config: AimuxConfig): Map<string, SessionInfo[]> {
  const map = new Map<string, SessionInfo[]>();
  for (const name of Object.keys(config.profiles)) {
    map.set(name, listSessions(config, name));
  }
  return map;
}

export function formatRelativeTime(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Returns a short timestamp string:
 * - "27s" / "12m" / "3h" within the last day
 * - "12 May 14:32" within the current year
 * - "12 May 2025" if older than the current year
 */
export function formatSmartTimestamp(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const DAY = 24 * 60 * 60 * 1000;
  if (diff < DAY) return formatRelativeTime(ms, now);
  const d = new Date(ms);
  const nowDate = new Date(now);
  const sameYear = d.getFullYear() === nowDate.getFullYear();
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  if (sameYear) return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${date} ${d.getFullYear()}`;
}

export function shortenPath(path: string, home: string = process.env.HOME ?? ''): string {
  if (!path) return '';
  if (home && path.startsWith(home)) return '~' + path.slice(home.length);
  return path;
}
