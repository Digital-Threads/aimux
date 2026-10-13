import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getAimuxDir } from './paths.js';

/** One request found in a transcript: what was spent, when, on which model. */
export interface UsageRow {
  /** Identifies the request across transcripts (a fork repeats its parent's requests). */
  key: string;
  at: number;
  sessionId: string;
  model: string;
  /** The directory the session ran in, when the transcript says. */
  cwd: string | null;
  /** input, cache write, cache read, output tokens, and the cost when the provider gave one. */
  usage: [number, number, number, number, number];
}

// 2: a codex call is keyed by its figures (was: its timestamp), a request repeated within
// a claude transcript is kept once.
const VERSION = 2;

interface TranscriptIndex {
  v: typeof VERSION;
  /** A fingerprint of the file's first bytes: a different start is a different file. */
  head: string;
  /** How far the file has been read: the end of its last complete line. */
  offset: number;
  /** How many lines that was. */
  lines: number;
  rows: UsageRow[];
  /** codex: what reading the rollout carries from line to line. */
  codex?: CodexState;
}

interface CodexState {
  sessionId: string;
  /** The session this one was forked from: its rollout opens with a copy of that one's calls. */
  forkedFrom?: string;
  /** The thread that started this one — a subagent's parent, or what it was forked from. */
  parent?: string;
  model: string;
  cwd: string | null;
  /** The running total the last counted call stated: the same total again is no new call. */
  total: number;
}

const CHUNK_BYTES = 1 << 20;
const HEAD_BYTES = 256;
const MARKER = Buffer.from('"usage"');
const CODEX_MARKERS = ['"token_count"', '"turn_context"', '"session_meta"'].map((m) => Buffer.from(m));

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const indexName = (filePath: string) => `${createHash('sha1').update(filePath).digest('hex').slice(0, 20)}.json`;
const indexDir = () => join(getAimuxDir(), 'usage-index');
const indexPath = (filePath: string) => join(indexDir(), indexName(filePath));

/**
 * Write a file under ~/.aimux/usage-index, readable by this user only: it names projects
 * and sessions, like the transcripts it was read from. Written aside and renamed, so two
 * scans at once never leave half a file.
 */
function writeIndexFile(path: string, value: unknown): void {
  mkdirSync(indexDir(), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.${process.pid}`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.${process.pid}`, path);
}

/** The usage a transcript line records, or nothing: only an assistant reply from a real model counts. */
function rowOf(raw: string, lineIndex: number, fallbackSessionId: string, fallbackMs: number): UsageRow | null {
  let line: any;
  try {
    line = JSON.parse(raw);
  } catch {
    return null;
  }

  const usage = line?.message?.usage;
  if (!line || line.type !== 'assistant' || !usage) return null;
  // Claude Code writes its own notices (a spent limit, an API error) as assistant
  // records with model `<synthetic>` and zero usage — no request was made.
  if (line.message.model === '<synthetic>') return null;

  const sessionId: string = line.sessionId ?? fallbackSessionId;
  const parsed = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
  const key = line.requestId
    ? `request:${line.requestId}`
    : line.message.id
      ? `${sessionId}:message:${line.message.id}`
      : line.uuid
        ? `${sessionId}:uuid:${line.uuid}`
        : `${sessionId}:line:${lineIndex}`;

  return {
    key,
    at: Number.isNaN(parsed) ? fallbackMs : parsed,
    sessionId,
    model: typeof line.message.model === 'string' && line.message.model.trim() ? line.message.model : 'unknown',
    cwd: typeof line.cwd === 'string' && line.cwd ? line.cwd : null,
    usage: [
      num(usage.input_tokens),
      num(usage.cache_creation_input_tokens),
      num(usage.cache_read_input_tokens),
      num(usage.output_tokens),
      num(usage.estimated_cost_usd ?? usage.cost_usd),
    ],
  };
}

/**
 * The model call a codex rollout line records, or nothing. With every call codex states
 * what that call spent and a running total. The total starts over each time the session
 * is resumed, so its last value is not what the session spent: the calls are counted one
 * by one, and the total only tells a new call from a repeat — codex writes the same
 * figures again when nothing but the limits changed.
 *
 * A call is keyed by its figures, not its time: a forked session's rollout opens with a
 * copy of its parent's calls under new timestamps, and the figures are what still match.
 */
function codexRowOf(raw: string, state: CodexState, fallbackSessionId: string, fallbackMs: number): UsageRow | null {
  let line: any;
  try {
    line = JSON.parse(raw);
  } catch {
    return null;
  }

  const payload = line?.payload;
  if (!payload) return null;

  if (line.type === 'session_meta') {
    // Only the first one names this session: a fork carries its parent's right after its own.
    if (state.sessionId || typeof payload.id !== 'string') return null;

    state.sessionId = payload.id;
    if (typeof payload.cwd === 'string' && payload.cwd) state.cwd = payload.cwd;
    if (typeof payload.forked_from_id === 'string') state.forkedFrom = payload.forked_from_id;

    const parent = payload.parent_thread_id ?? payload.source?.subagent?.thread_spawn?.parent_thread_id ?? payload.forked_from_id;
    if (typeof parent === 'string') state.parent = parent;
    return null;
  }

  if (line.type === 'turn_context') {
    if (typeof payload.model === 'string' && payload.model) state.model = payload.model;
    if (typeof payload.cwd === 'string' && payload.cwd) state.cwd = payload.cwd;
    return null;
  }

  const spent = payload.info?.last_token_usage;
  if (line.type !== 'event_msg' || payload.type !== 'token_count' || !spent) return null;

  const total = num(payload.info.total_token_usage?.total_tokens);
  if (total === state.total) return null;
  state.total = total;

  const parsed = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
  const input = num(spent.input_tokens);
  const cached = num(spent.cached_input_tokens); // a part of input_tokens, not on top of it
  const output = num(spent.output_tokens);

  return {
    key: `codex:${total}:${input}:${cached}:${output}`,
    at: Number.isNaN(parsed) ? fallbackMs : parsed,
    sessionId: state.sessionId || fallbackSessionId,
    // Priced as the codex flagship when the rollout names no model, never at $0.
    model: state.model || 'gpt-5-codex',
    cwd: state.cwd,
    usage: [Math.max(0, input - cached), 0, cached, output, 0],
  };
}

/**
 * Feed a file to `onLine` one complete line at a time, from byte `from`, a megabyte in
 * memory at once. Answers where the last complete line ended, and the unterminated
 * piece after it, if any.
 */
function readLines(fd: number, from: number, onLine: (line: Buffer) => void): { offset: number; tail: Buffer | null } {
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  // The pieces of a line that runs across chunks, copied out: `buf` is read into again.
  let carry: Buffer[] = [];
  let position = from;
  let offset = from;

  for (;;) {
    const read = readSync(fd, buf, 0, CHUNK_BYTES, position);
    if (read === 0) break;

    const chunk = buf.subarray(0, read);
    let start = 0;
    for (let end = chunk.indexOf(10, start); end !== -1; end = chunk.indexOf(10, start)) {
      onLine(carry.length > 0 ? Buffer.concat([...carry, chunk.subarray(start, end)]) : chunk.subarray(start, end));
      carry = [];
      start = end + 1;
      offset = position + start;
    }

    if (start < read) carry.push(Buffer.from(chunk.subarray(start)));
    position += read;
  }

  return { offset, tail: carry.length > 0 ? Buffer.concat(carry) : null };
}

/**
 * A claude transcript or a codex rollout as its index has it, after reading what was
 * appended since last time. Nothing when the file cannot be opened.
 *
 * These files only grow, and grow large — hundreds of megabytes for claude, gigabytes for
 * codex, past what Node can load as one string, so reading them whole used to drop the
 * heaviest sessions without a word. So the file is read in chunks, a line is only turned
 * into text when it mentions usage (nearly all of it is tool output with nothing to
 * count), and what was found is kept under ~/.aimux/usage-index with the place reading
 * stopped. A line still being written (no newline yet, not yet valid JSON) is left for
 * the next call.
 */
function readIndexed(filePath: string, mtimeMs: number, kind: 'claude' | 'codex'): TranscriptIndex | null {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return null;
  }

  let index: TranscriptIndex = { v: VERSION, head: '', offset: 0, lines: 0, rows: [] };

  try {
    const headBuf = Buffer.alloc(HEAD_BYTES);
    const headLen = readSync(fd, headBuf, 0, HEAD_BYTES, 0);
    index.head = createHash('sha1').update(headBuf.subarray(0, headLen)).digest('hex');

    try {
      const saved = JSON.parse(readFileSync(indexPath(filePath), 'utf-8')) as TranscriptIndex;
      // The same start and at least as long as last time: the file that was read, grown.
      const isSameFile = saved.v === VERSION && saved.head === index.head && saved.offset <= fstatSync(fd).size;
      if (isSameFile && Array.isArray(saved.rows) && typeof saved.lines === 'number') index = saved;
    } catch {
      // never read before, or the file was replaced or cut short: from the top
    }

    const startedAt = index.offset;
    const name = basename(filePath).replace(/\.jsonl$/, '');
    const codex: CodexState = index.codex ?? { sessionId: '', model: '', cwd: null, total: -1 };
    if (kind === 'codex') index.codex = codex;
    const codexId = rolloutId(filePath);
    // Claude Code writes a request once per block of its reply, the same usage each time.
    const seen = new Set(kind === 'claude' ? index.rows.map((row) => row.key) : []);

    const take = (line: Buffer) => {
      index.lines++;

      let row: UsageRow | null = null;
      try {
        if (kind === 'codex') {
          if (CODEX_MARKERS.some((m) => line.includes(m))) row = codexRowOf(line.toString('utf-8'), codex, codexId, mtimeMs);
        } else if (line.includes(MARKER)) {
          row = rowOf(line.toString('utf-8'), index.lines - 1, name, mtimeMs);
        }
      } catch {
        return; // a line too long to hold as text: nothing a request would be written in
      }
      if (!row || seen.has(row.key)) return;

      if (kind === 'claude') seen.add(row.key);
      index.rows.push(row);
    };

    const { offset, tail } = readLines(fd, index.offset, take);
    index.offset = offset;

    // A last line with no newline: counted if it is already whole, left for next time if
    // it is still being written.
    if (tail) {
      let isWhole = true;
      try {
        JSON.parse(tail.toString('utf-8'));
      } catch {
        isWhole = false;
      }

      if (isWhole) {
        take(tail);
        index.offset = offset + tail.length;
      }
    }

    if (index.offset !== startedAt) {
      try {
        writeIndexFile(indexPath(filePath), index);
      } catch {
        // the index only saves time: without it the next scan reads from the top again
      }
    }
  } catch {
    // A read that failed midway. What was found stands; nothing is saved, so the next
    // scan picks up from where the last saved one stopped.
  } finally {
    closeSync(fd);
  }

  return index;
}

// ponytail: one JSON object per request, so the index runs to ~250 bytes a request and is
// rewritten whole when its file grows; pack rows as arrays over a string table if the size
// or the rewrite of a long-lived session's index starts to show.

/** The session a rollout is named after: `rollout-<date>-<session id>.jsonl`. */
function rolloutId(filePath: string): string {
  const name = basename(filePath).replace(/\.jsonl$/, '');

  return /[0-9a-fA-F-]{36}$/.exec(name)?.[0] ?? name;
}

/** Every request a claude transcript records, each once. */
export function usageRows(filePath: string, mtimeMs: number): UsageRow[] {
  return readIndexed(filePath, mtimeMs, 'claude')?.rows ?? [];
}

/** A codex session as its rollout tells it: every model call, and where the session came from. */
export interface CodexCalls {
  sessionId: string;
  forkedFrom?: string;
  parent?: string;
  rows: UsageRow[];
}

export function codexCalls(filePath: string, mtimeMs: number): CodexCalls {
  const index = readIndexed(filePath, mtimeMs, 'codex');

  return { sessionId: index?.codex?.sessionId || rolloutId(filePath), forkedFrom: index?.codex?.forkedFrom, parent: index?.codex?.parent, rows: index?.rows ?? [] };
}

/** What a scan remembers about one file, so the next scan need not open it again. */
export interface FileNote {
  size: number;
  mtimeMs: number;
  /** Not a conversation to count (a background helper's own transcript). */
  skip?: boolean;
}

/**
 * The notes kept between scans (`~/.aimux/usage-index/files.json`). A machine that has
 * run Claude Code for months holds tens of thousands of transcripts — nearly all of them
 * background helpers', which a scan used to open one by one just to set aside, every
 * time. Call `save()` once the scan is done.
 */
export function openScanNotes(): {
  get(path: string): FileNote | undefined;
  put(path: string, note: FileNote): void;
  /** After a scan of everything: forget the files it did not meet, and their indexes. */
  prune(met: Set<string>): void;
  save(): void;
} {
  const path = join(indexDir(), 'files.json');
  let files: Record<string, FileNote> = {};
  let isDirty = false;

  try {
    const saved = JSON.parse(readFileSync(path, 'utf-8'));
    if (saved.v === 1 && saved.files && typeof saved.files === 'object') files = saved.files;
  } catch {
    // first scan
  }

  return {
    get: (file) => files[file],
    put(file, note) {
      files[file] = note;
      isDirty = true;
    },
    // Transcripts are deleted in time (Claude Code clears old ones itself); what was kept
    // about them would otherwise stay for good. Only a scan of everything can tell.
    prune(met) {
      for (const file of Object.keys(files)) {
        if (met.has(file)) continue;

        delete files[file];
        isDirty = true;
      }

      const kept = new Set([...met].map(indexName));
      try {
        for (const name of readdirSync(indexDir())) {
          if (name !== 'files.json' && name.endsWith('.json') && !kept.has(name)) rmSync(join(indexDir(), name), { force: true });
        }
      } catch {
        // nothing indexed yet
      }
    },
    save() {
      if (!isDirty) return;

      try {
        writeIndexFile(path, { v: 1, files });
      } catch {
        // the notes only save time
      }
    },
  };
}
