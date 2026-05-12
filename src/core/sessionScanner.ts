import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AimuxConfig } from '../types/index.js';
import { expandHome } from './paths.js';

export interface InteractiveSession {
  sessionId: string;
  cwd: string;
  intent: string;
  cwdHashDir: string;
  createdAtMs: number;
  updatedAtMs: number;
  events: number;
}

interface LineCandidate {
  cwd?: string;
  type?: string;
  isMeta?: boolean;
  userType?: string;
  entrypoint?: string;
  timestamp?: string;
  operation?: string;
  message?: { role?: string; content?: string | unknown };
}

function safeParse(line: string): LineCandidate | null {
  try {
    return JSON.parse(line) as LineCandidate;
  } catch {
    return null;
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && 'text' in c && typeof (c as { text: unknown }).text === 'string') {
          return (c as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function isMetaPrompt(text: string): boolean {
  if (!text) return true;
  if (text.startsWith('<local-command-caveat>')) return true;
  if (text.startsWith('<command-name>')) return true;
  if (text.startsWith('<command-message>')) return true;
  if (text.startsWith('<system-reminder>')) return true;
  return false;
}

const MAX_SCAN_LINES = 40;

export function parseSessionJsonl(
  path: string,
): Pick<InteractiveSession, 'cwd' | 'intent' | 'createdAtMs' | 'events'> & {
  isSubagent: boolean;
} {
  let cwd = '';
  let intent = '';
  let createdAtMs = 0;
  let events = 0;
  let hasExternalUserMessage = false;
  let hasQueueOperation = false;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { cwd, intent, createdAtMs, events, isSubagent: true };
  }

  const lines = raw.split('\n');
  events = lines.filter((l) => l.length > 0).length;

  for (let i = 0; i < Math.min(MAX_SCAN_LINES, lines.length); i++) {
    const line = lines[i];
    if (!line) continue;
    const obj = safeParse(line);
    if (!obj) continue;

    if (obj.type === 'queue-operation') hasQueueOperation = true;

    if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
    if (!createdAtMs && typeof obj.timestamp === 'string') {
      const t = Date.parse(obj.timestamp);
      if (!Number.isNaN(t)) createdAtMs = t;
    }

    if (obj.type === 'user' && obj.message?.role === 'user' && !obj.isMeta) {
      if (obj.userType === 'external' && (!obj.entrypoint || obj.entrypoint === 'cli')) {
        hasExternalUserMessage = true;
      }
      if (!intent) {
        const text = extractText(obj.message.content).trim();
        if (text && !isMetaPrompt(text)) {
          intent = text.length > 200 ? text.slice(0, 200) + '…' : text;
        }
      }
    }
  }

  // Sub-agent sessions: dominated by queue-operation entries, no external
  // human-typed user message. Classifier / memory / task-journal sub-agents
  // each get their own jsonl in projects/ but should not appear in the
  // user-facing session list.
  const isSubagent = hasQueueOperation && !hasExternalUserMessage;

  return { cwd, intent, createdAtMs, events, isSubagent };
}

export function scanInteractiveSessions(config: AimuxConfig): InteractiveSession[] {
  const projectsRoot = join(expandHome(config.shared_source), 'projects');
  if (!existsSync(projectsRoot)) return [];

  let cwdDirs: string[];
  try {
    cwdDirs = readdirSync(projectsRoot);
  } catch {
    return [];
  }

  const sessions: InteractiveSession[] = [];

  for (const cwdHashDir of cwdDirs) {
    const dirPath = join(projectsRoot, cwdHashDir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(dirPath, file);
      const sessionId = file.replace(/\.jsonl$/, '');
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }
      const parsed = parseSessionJsonl(filePath);
      if (parsed.isSubagent) continue;
      sessions.push({
        sessionId,
        cwd: parsed.cwd || decodeHashedCwd(cwdHashDir),
        intent: parsed.intent,
        cwdHashDir,
        createdAtMs: parsed.createdAtMs || stat.birthtimeMs || stat.mtimeMs,
        updatedAtMs: stat.mtimeMs,
        events: parsed.events,
      });
    }
  }

  sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return sessions;
}

export function decodeHashedCwd(hashed: string): string {
  // Claude encodes cwd as dash-separated path: /home/user/foo -> -home-user-foo
  if (!hashed.startsWith('-')) return hashed;
  return '/' + hashed.slice(1).replace(/-/g, '/');
}
