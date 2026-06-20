import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome } from './paths.js';
import type { InteractiveSession } from './sessionScanner.js';

// Codex stores each session as a JSONL "rollout" under
// <source>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl. Record shape is
// { timestamp, type, payload } with types session_meta | turn_context |
// response_item | event_msg (verified against codex-cli 0.139.0).

interface ScanCodexOptions {
  windowDays?: number;
  /** Injectable clock for deterministic windowing in tests. */
  now?: number;
}

function parseJson(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Best-effort text extraction from a codex response_item content field, which is
 *  either a string or an array of parts ({ text } / { type, text }). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  return '';
}

function listRolloutFiles(sessionsRoot: string): string[] {
  const out: string[] = [];
  const stack = [sessionsRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push(p);
    }
  }
  return out;
}

/** Scan a codex source dir for interactive sessions, returning records compatible with
 *  the claude `InteractiveSession` shape so `unifyAllSessions` can merge both. */
export function scanCodexInteractive(sourceDir: string, opts: ScanCodexOptions = {}): InteractiveSession[] {
  const sessionsRoot = join(expandHome(sourceDir), 'sessions');
  if (!existsSync(sessionsRoot)) return [];

  const windowDays = opts.windowDays ?? 7;
  const now = opts.now ?? 0; // 0 => no windowing (tests pass explicit now)
  const windowCutoff = now > 0 && Number.isFinite(windowDays) ? now - windowDays * 86_400_000 : -Infinity;

  const sessions: InteractiveSession[] = [];

  for (const filePath of listRolloutFiles(sessionsRoot)) {
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (stat.mtimeMs < windowCutoff) continue;

    let lines: string[];
    try {
      lines = readFileSync(filePath, 'utf-8').split('\n');
    } catch {
      continue;
    }

    let sessionId = '';
    let cwd = '';
    let createdAtMs = 0;
    let intent = '';
    let events = 0;

    for (const raw of lines) {
      if (!raw) continue;
      const rec = parseJson(raw);
      const payload = rec?.payload;
      if (!rec || !payload) continue;

      if (rec.type === 'session_meta') {
        sessionId = payload.id ?? sessionId;
        cwd = payload.cwd ?? cwd;
        const t = Date.parse(rec.timestamp ?? payload.timestamp ?? '');
        if (!Number.isNaN(t)) createdAtMs = t;
      } else if (rec.type === 'response_item') {
        events += 1;
        if (!intent && payload.role === 'user') {
          intent = contentText(payload.content);
        }
      }
    }

    if (!sessionId) {
      const m = /rollout-.*-([0-9a-fA-F-]{36})\.jsonl$/.exec(filePath);
      if (m) sessionId = m[1];
      else continue;
    }

    sessions.push({
      sessionId,
      cwd,
      intent,
      title: '',
      cwdHashDir: '',
      createdAtMs: createdAtMs || stat.birthtimeMs || stat.mtimeMs,
      updatedAtMs: stat.mtimeMs,
      events,
    });
  }

  sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return sessions;
}
