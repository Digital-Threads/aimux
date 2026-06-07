import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { AimuxConfig } from '../types/index.js';
import { expandHome } from './paths.js';

export interface InteractiveSession {
  sessionId: string;
  cwd: string;
  intent: string;
  /** Explicit session title: user `/rename` (custom-title) or claude's ai-title. */
  title: string;
  cwdHashDir: string;
  createdAtMs: number;
  updatedAtMs: number;
  events: number;
  /** True when the jsonl was only stat'd, not parsed (outside scan window). */
  isStub?: boolean;
}

export interface ScanOptions {
  /** Sessions with mtime older than this many days are stubbed (no jsonl parse). */
  windowDays?: number;
}

interface LineCandidate {
  cwd?: string;
  type?: string;
  isMeta?: boolean;
  userType?: string;
  entrypoint?: string;
  timestamp?: string;
  operation?: string;
  customTitle?: string;
  aiTitle?: string;
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

export function isMetaPrompt(text: string): boolean {
  if (!text) return true;
  if (text.startsWith('<local-command-caveat>')) return true;
  if (text.startsWith('<local-command-stdout>')) return true;
  if (text.startsWith('<local-command-stderr>')) return true;
  if (text.startsWith('<command-name>')) return true;
  if (text.startsWith('<command-message>')) return true;
  if (text.startsWith('<system-reminder>')) return true;
  // Compaction-continuation summary injected on resume — not a human prompt.
  if (text.startsWith('This session is being continued from a previous c')) return true;
  return false;
}

const MAX_SCAN_LINES = 40;
const HEAD_READ_BYTES = 128 * 1024;
const FULL_READ_THRESHOLD = 256 * 1024;
// Title lines are appended near the end; the last 64KB reliably covers the most
// recent custom-title/ai-title without paying to re-read the whole transcript.
const TAIL_READ_BYTES = 64 * 1024;

function readHeadOrFull(filePath: string, totalSize: number): string {
  if (totalSize <= FULL_READ_THRESHOLD) {
    try {
      return readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  }
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(HEAD_READ_BYTES);
    const n = readSync(fd, buf, 0, HEAD_READ_BYTES, 0);
    return buf.subarray(0, n).toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function readTail(filePath: string, totalSize: number, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    const len = Math.min(bytes, totalSize);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, Math.max(0, totalSize - len));
    return buf.subarray(0, n).toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

// claude appends `{"type":"custom-title","customTitle":…}` (set via /rename) and
// `{"type":"ai-title","aiTitle":…}` lines as the title changes. Last one wins;
// a user rename (custom) always beats the generated ai-title.
function scanTitles(lines: string[], acc: { custom: string; ai: string }): void {
  for (const line of lines) {
    if (!line) continue;
    if (line.includes('"custom-title"')) {
      const o = safeParse(line);
      if (o?.type === 'custom-title' && typeof o.customTitle === 'string' && o.customTitle.trim()) {
        acc.custom = o.customTitle.trim();
      }
    } else if (line.includes('"ai-title"')) {
      const o = safeParse(line);
      if (o?.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim()) {
        acc.ai = o.aiTitle.trim();
      }
    }
  }
}

export function parseSessionJsonl(
  path: string,
  totalSize?: number,
): Pick<InteractiveSession, 'cwd' | 'intent' | 'title' | 'createdAtMs' | 'events'> & {
  isSubagent: boolean;
} {
  let cwd = '';
  let intent = '';
  let createdAtMs = 0;
  let events = 0;
  let hasExternalUserMessage = false;
  let hasQueueOperation = false;

  let raw: string;
  if (totalSize === undefined) {
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      return { cwd, intent, title: '', createdAtMs, events, isSubagent: true };
    }
  } else {
    raw = readHeadOrFull(path, totalSize);
    if (!raw) {
      return { cwd, intent, title: '', createdAtMs, events, isSubagent: true };
    }
  }

  const isPartial = totalSize !== undefined && totalSize > FULL_READ_THRESHOLD;
  const rawLines = raw.split('\n');
  // Drop the trailing partial line when we only read the head — it is
  // likely truncated mid-JSON and would just produce a parse miss.
  const lines = isPartial ? rawLines.slice(0, -1) : rawLines;
  const nonEmptyCount = lines.reduce((acc, l) => acc + (l.length > 0 ? 1 : 0), 0);

  if (isPartial && totalSize) {
    const avgLineBytes = nonEmptyCount > 0 ? raw.length / nonEmptyCount : 1024;
    events = Math.max(nonEmptyCount, Math.round(totalSize / avgLineBytes));
  } else {
    events = nonEmptyCount;
  }

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

  // Title (custom-title / ai-title) is appended as the session goes — often
  // far past the head we scan for intent. Scan all lines we already have, then
  // (for head-only reads) the tail, since the latest title lives at the end.
  const titleAcc = { custom: '', ai: '' };
  scanTitles(lines, titleAcc);
  if (isPartial && totalSize !== undefined) {
    const tail = readTail(path, totalSize, TAIL_READ_BYTES);
    if (tail) scanTitles(tail.split('\n'), titleAcc);
  }
  const rawTitle = titleAcc.custom || titleAcc.ai;
  const title = rawTitle.length > 80 ? rawTitle.slice(0, 80) + '…' : rawTitle;

  // Sub-agent sessions: dominated by queue-operation entries, no external
  // human-typed user message. Classifier / memory / task-journal sub-agents
  // each get their own jsonl in projects/ but should not appear in the
  // user-facing session list.
  const isSubagent = hasQueueOperation && !hasExternalUserMessage;

  return { cwd, intent, title, createdAtMs, events, isSubagent };
}

export function quickFirstLineType(filePath: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(256);
    const read = readSync(fd, buf, 0, 256, 0);
    const text = buf.subarray(0, read).toString('utf-8');
    const nl = text.indexOf('\n');
    const firstLine = nl >= 0 ? text.slice(0, nl) : text;
    if (!firstLine.trim()) return null;
    const obj = safeParse(firstLine);
    return obj?.type ?? null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

// Per-file parse cache keyed by path. A jsonl's intent/cwd/subagent-ness only
// changes when the file does, so we re-parse only when (mtime,size) move. This
// keeps the live-refresh poll and the re-mount after attach cheap (a cold scan
// of ~44 sessions is ~150ms; a warm re-scan is a handful of stat() calls).
// `result: null` memoizes "skip this file" (subagent / queue-driven).
interface ScanCacheEntry {
  mtimeMs: number;
  size: number;
  result: { cwd: string; intent: string; title: string; createdAtMs: number; events: number } | null;
}
const scanCache = new Map<string, ScanCacheEntry>();

export function scanInteractiveSessions(
  config: AimuxConfig,
  opts: ScanOptions = {},
): InteractiveSession[] {
  const projectsRoot = join(expandHome(config.shared_source), 'projects');
  if (!existsSync(projectsRoot)) return [];

  let cwdDirs: string[];
  try {
    cwdDirs = readdirSync(projectsRoot);
  } catch {
    return [];
  }

  const windowDays = opts.windowDays ?? 7;
  const windowCutoff = Number.isFinite(windowDays)
    ? Date.now() - windowDays * 24 * 60 * 60 * 1000
    : -Infinity;

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

      const insideWindow = stat.mtimeMs >= windowCutoff;

      // Outside the scan window: skip entirely. No stat-open-read on the
      // jsonl, no quick subagent probe — saves thousands of opens when
      // projects/ has accumulated long-lived background-agent files.
      // The user surfaces them on demand via [L] (windowDays = Infinity).
      if (!insideWindow) continue;

      // Warm path: file unchanged since last scan → reuse the parsed result
      // (or the memoized skip) without opening it. updatedAtMs still tracks the
      // live mtime, so an active session's timestamp stays fresh.
      const cached = scanCache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        if (cached.result === null) continue;
        sessions.push({
          sessionId,
          cwd: cached.result.cwd || decodeHashedCwd(cwdHashDir),
          intent: cached.result.intent,
          title: cached.result.title,
          cwdHashDir,
          createdAtMs: cached.result.createdAtMs || stat.birthtimeMs || stat.mtimeMs,
          updatedAtMs: stat.mtimeMs,
          events: cached.result.events,
        });
        continue;
      }

      // Fast subagent reject: first line of a queue-driven session is
      // a queue-operation. Real interactive sessions start with
      // permission-mode / file-history-snapshot / user / etc.
      if (quickFirstLineType(filePath) === 'queue-operation') {
        scanCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, result: null });
        continue;
      }

      const parsed = parseSessionJsonl(filePath, stat.size);
      if (parsed.isSubagent) {
        scanCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, result: null });
        continue;
      }
      const result = {
        cwd: parsed.cwd,
        intent: parsed.intent,
        title: parsed.title,
        createdAtMs: parsed.createdAtMs,
        events: parsed.events,
      };
      scanCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, result });
      sessions.push({
        sessionId,
        cwd: parsed.cwd || decodeHashedCwd(cwdHashDir),
        intent: parsed.intent,
        title: parsed.title,
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
