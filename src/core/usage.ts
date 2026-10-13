import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AimuxConfig } from '../types/index.js';
import { expandHome } from './paths.js';
import { sourceFor } from './config.js';
import { loadSessionHistory } from './sessionHistory.js';
import { ownerAt, sessionOwners, type SessionOwner } from './sessionMarkers.js';
import { buildProfileSessionMap } from './profileSessionMap.js';
import { parseSessionJsonl, quickFirstLineType } from './sessionScanner.js';
import { listRolloutFiles } from './codexSessionScanner.js';
import { estimateCost } from './pricing.js';
import { codexCalls, openScanNotes, usageRows, type CodexCalls, type UsageRow } from './transcriptIndex.js';

export interface UsageTotals {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface ProfileUsageSummary extends UsageTotals {
  profile: string;
  sessions: number;
  requests: number;
  models: Map<string, number>;
}

export interface SessionUsageSummary extends UsageTotals {
  sessionId: string;
  profile: string;
  requests: number;
}

export interface UsageOptions {
  sinceMs?: number;
  profile?: string;
}

interface UsagePayload {
  input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  output_tokens?: unknown;
  estimated_cost_usd?: unknown;
  cost_usd?: unknown;
}

function emptySummary(profile: string): ProfileUsageSummary {
  return {
    profile,
    sessions: 0,
    requests: 0,
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    models: new Map<string, number>(),
  };
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function addUsage(summary: UsageTotals, usage: UsagePayload, model: string): void {
  const inputTokens = numberValue(usage.input_tokens);
  const cacheCreationInputTokens = numberValue(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = numberValue(usage.cache_read_input_tokens);
  const outputTokens = numberValue(usage.output_tokens);
  summary.inputTokens += inputTokens;
  summary.cacheCreationInputTokens += cacheCreationInputTokens;
  summary.cacheReadInputTokens += cacheReadInputTokens;
  summary.outputTokens += outputTokens;
  // Subscription transcripts carry no cost; fall back to the price table.
  // When a provider does emit a cost field, trust it over the estimate.
  const transcriptCost = numberValue(usage.estimated_cost_usd ?? usage.cost_usd);
  summary.estimatedCostUsd +=
    transcriptCost > 0
      ? transcriptCost
      : estimateCost(
          {
            inputTokens,
            cacheCreationInputTokens,
            cacheReadInputTokens,
            outputTokens,
            estimatedCostUsd: 0,
          },
          model,
        );
}

export function parseSinceDuration(input: string, nowMs = Date.now()): number {
  const match = input.trim().match(/^(\d+(?:\.\d+)?)([hdw])$/i);
  if (!match) {
    throw new Error(`Invalid duration '${input}'. Use values like 24h, 7d, or 4w.`);
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === 'h'
      ? 60 * 60 * 1000
      : unit === 'd'
        ? 24 * 60 * 60 * 1000
        : 7 * 24 * 60 * 60 * 1000;
  return nowMs - amount * multiplier;
}

interface UsageRecord {
  profile: string;
  cli: 'claude' | 'codex';
  sessionId: string;
  model: string;
  usage: UsagePayload;
  /** When the request was made. */
  at: number;
  /** The directory the session ran in. */
  project: string;
}

// All usage records across every configured CLI → deduplicated per-request. Shared by
// summarizeUsage (group by profile) and usageBySession (group by session) so both stay
// in sync. claude transcripts and codex rollouts live in different trees/formats, so each
// CLI has its own collector; profile attribution (history → 'unknown' fallback) is shared.
function collectUsageRecords(config: AimuxConfig, options: UsageOptions = {}): UsageRecord[] {
  const notes = openScanNotes();
  // Every transcript and rollout the scan met, counted or not.
  const met = new Set<string>();

  // Joined, not pushed with a spread: a busy machine has more records than a call takes arguments.
  const claude = collectClaudeUsageRecords(config, options, notes, met);
  const records = Object.values(config.profiles).some((p) => p.cli === 'codex')
    ? claude.concat(collectCodexUsageRecords(config, options, met))
    : claude;

  // Only a scan of everything has met every file there is, and none at all means the
  // transcripts could not be reached — not that they are gone.
  if (options.sinceMs === undefined && met.size > 0) notes.prune(met);
  notes.save();

  return records;
}

type ScanNotes = ReturnType<typeof openScanNotes>;

function payloadOf(row: UsageRow): UsagePayload {
  const [input, cacheWrite, cacheRead, output, cost] = row.usage;

  return {
    input_tokens: input,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
    output_tokens: output,
    estimated_cost_usd: cost,
  };
}

// Past this size only a transcript's head is read to classify it, so the verdict on it
// can no longer change (sessionScanner's FULL_READ_THRESHOLD).
const SETTLED_BYTES = 256 * 1024;

// claude: one deduplicated record per assistant request, scanned from the shared
// projects/*.jsonl transcript tree.
function collectClaudeUsageRecords(config: AimuxConfig, options: UsageOptions, notes: ScanNotes, met: Set<string>): UsageRecord[] {
  const projectsRoot = join(expandHome(config.shared_source), 'projects');
  const records: UsageRecord[] = [];
  if (!existsSync(projectsRoot)) return records;

  const seenRequests = new Set<string>();
  const history = loadSessionHistory();
  const profileMap = buildProfileSessionMap(config);
  const owners = sessionOwners(config);

  let cwdDirs: string[];
  try {
    cwdDirs = readdirSync(projectsRoot);
  } catch {
    return records;
  }

  for (const cwdDir of cwdDirs) {
    const dirPath = join(projectsRoot, cwdDir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(dirPath, file);
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }
      met.add(filePath);
      // Nothing written yet: nothing to count, and nothing to judge the file by.
      if (stat.size === 0) continue;
      if (options.sinceMs !== undefined && stat.mtimeMs < options.sinceMs) continue;

      // A background helper's own transcript is not a conversation to count. Telling
      // costs opening the file, and there are tens of thousands of them, so the answer
      // is kept — and asked again while the file is still short and still growing, when
      // its first lines may not have said yet what it is.
      const note = notes.get(filePath);
      let skip = note?.skip;
      if (skip === undefined || (note!.size !== stat.size && note!.size < SETTLED_BYTES)) {
        skip = quickFirstLineType(filePath) === 'queue-operation' || parseSessionJsonl(filePath, stat.size).isSubagent;
        notes.put(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, skip });
      }
      if (skip) continue;

      const fallbackSessionId = file.replace(/\.jsonl$/, '');

      for (const row of usageRows(filePath, stat.mtimeMs)) {
        if (options.sinceMs !== undefined && row.at < options.sinceMs) continue;

        const sessionId = row.sessionId;
        // Order matters. aimux's own record of a session it attached to is explicit, so it
        // wins. Next the session-env marker Claude Code left in the config dir that ran this
        // turn: decided per turn, so a session continued on another subscription is split
        // between the two. `.claude.json`'s lastSessionId comes after it — it names only a
        // profile's latest session, and names it whole.
        const profile =
          history.get(sessionId)?.profile
          ?? history.get(fallbackSessionId)?.profile
          ?? ownerAt(owners.get(sessionId) ?? owners.get(fallbackSessionId), row.at)
          ?? profileMap.get(sessionId)?.profile
          ?? profileMap.get(fallbackSessionId)?.profile
          ?? 'unknown';
        if (options.profile && profile !== options.profile) continue;

        if (seenRequests.has(row.key)) continue;
        seenRequests.add(row.key);

        records.push({ profile, cli: 'claude', sessionId, model: row.model, usage: payloadOf(row), at: row.at, project: row.cwd || cwdDir });
      }
    }
  }

  return records;
}

/**
 * Who typed into each codex session, and when, earliest first. codex keeps every prompt
 * in the config dir that sent it (`history.jsonl`, not shared between profiles), which
 * says whose subscription each turn ran on. A prompt typed into plain `codex` lands in
 * the source dir's file: no profile's turn, but the end of a profile's stretch.
 */
function codexPromptOwners(config: AimuxConfig): Map<string, SessionOwner[]> {
  const owners = new Map<string, SessionOwner[]>();
  const dirs = new Map<string, string>([[expandHome(sourceFor(config, 'codex')), 'unknown']]);
  for (const [name, p] of Object.entries(config.profiles)) {
    if (p.cli === 'codex') dirs.set(expandHome(p.path), name);
  }

  for (const [dir, profile] of dirs) {
    let text: string;
    try {
      text = readFileSync(join(dir, 'history.jsonl'), 'utf-8');
    } catch {
      continue;
    }

    for (const line of text.split('\n')) {
      let entry: { session_id?: unknown; ts?: unknown };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry?.session_id !== 'string' || typeof entry.ts !== 'number') continue;

      const list = owners.get(entry.session_id) ?? [];
      list.push({ profile, since: entry.ts * 1000 });
      owners.set(entry.session_id, list);
    }
  }

  for (const list of owners.values()) list.sort((a, b) => a.since - b.since);
  return owners;
}

// codex: one record per model call, read from the session's rollout JSONL.
function collectCodexUsageRecords(config: AimuxConfig, options: UsageOptions, met: Set<string>): UsageRecord[] {
  const sessionsRoot = join(expandHome(sourceFor(config, 'codex')), 'sessions');
  const records: UsageRecord[] = [];
  if (!existsSync(sessionsRoot)) return records;

  const history = loadSessionHistory();
  const profileMap = buildProfileSessionMap(config);
  const owners = codexPromptOwners(config);

  const files = listRolloutFiles(sessionsRoot);
  // rollout-<date>-<session id>.jsonl: a session's file is found by name, none opened.
  const fileOf = new Map(files.map((file) => [/([0-9a-fA-F-]{36})\.jsonl$/.exec(file)?.[1] ?? file, file]));
  const read = new Map<string, CodexCalls | null>();
  const callsOf = (filePath: string): CodexCalls | null => {
    if (!read.has(filePath)) {
      try {
        read.set(filePath, codexCalls(filePath, statSync(filePath).mtimeMs));
      } catch {
        read.set(filePath, null);
      }
    }
    return read.get(filePath)!;
  };

  for (const filePath of files) {
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    met.add(filePath);
    if (options.sinceMs !== undefined && stat.mtimeMs < options.sinceMs) continue;

    const session = callsOf(filePath);
    if (!session) continue;

    // A forked session's rollout opens with a copy of every call its parent had made,
    // stamped with the moment of the fork. Those are the parent's calls and are counted
    // there, at their own time — whether or not the parent falls inside this window.
    const copied = new Set<string>();
    for (let from = session.forkedFrom, hops = 0; from && hops < 16; hops++) {
      const parent = fileOf.has(from) ? callsOf(fileOf.get(from)!) : null;
      if (!parent) break;

      for (const row of parent.rows) copied.add(row.key);
      from = parent.forkedFrom;
    }

    // Prompts are typed into the thread a subagent was started from, not into the subagent.
    const typedBy = owners.get(session.sessionId) ?? (session.parent ? owners.get(session.parent) : undefined);

    for (const row of session.rows) {
      if (copied.has(row.key)) continue;
      if (options.sinceMs !== undefined && row.at < options.sinceMs) continue;

      const profile =
        history.get(row.sessionId)?.profile
        ?? ownerAt(typedBy, row.at)
        ?? profileMap.get(row.sessionId)?.profile
        ?? 'unknown';
      if (options.profile && profile !== options.profile) continue;

      records.push({ profile, cli: 'codex', sessionId: row.sessionId, model: row.model, usage: payloadOf(row), at: row.at, project: row.cwd || 'unknown' });
    }
  }

  return records;
}

export function summarizeUsage(config: AimuxConfig, options: UsageOptions = {}): ProfileUsageSummary[] {
  const summaries = new Map<string, ProfileUsageSummary>();
  const sessionSets = new Map<string, Set<string>>();

  for (const profile of Object.keys(config.profiles)) {
    summaries.set(profile, emptySummary(profile));
    sessionSets.set(profile, new Set<string>());
  }

  for (const rec of collectUsageRecords(config, options)) {
    if (!summaries.has(rec.profile)) {
      summaries.set(rec.profile, emptySummary(rec.profile));
      sessionSets.set(rec.profile, new Set<string>());
    }
    const summary = summaries.get(rec.profile)!;
    summary.requests += 1;
    addUsage(summary, rec.usage, rec.model);
    summary.models.set(rec.model, (summary.models.get(rec.model) ?? 0) + 1);
    sessionSets.get(rec.profile)!.add(rec.sessionId);
  }

  for (const [profile, sessions] of sessionSets) {
    const summary = summaries.get(profile);
    if (summary) summary.sessions = sessions.size;
  }

  return Array.from(summaries.values())
    .filter((s) => !options.profile || s.profile === options.profile)
    .sort((a, b) => {
      if (a.profile === 'unknown') return 1;
      if (b.profile === 'unknown') return -1;
      return totalTokens(b) - totalTokens(a) || a.profile.localeCompare(b.profile);
    });
}

function emptySessionSummary(sessionId: string, profile: string): SessionUsageSummary {
  return {
    sessionId,
    profile,
    requests: 0,
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
}

// Per-session usage breakdown — same deduplicated transcript scan as summarizeUsage but
// keyed by session_id, so Loom can attribute spend to a task once task↔session_id is
// linked (the "spent" source for exact per-task cost).
export function usageBySession(config: AimuxConfig, options: UsageOptions = {}): SessionUsageSummary[] {
  const sessions = new Map<string, SessionUsageSummary>();

  for (const rec of collectUsageRecords(config, options)) {
    let summary = sessions.get(rec.sessionId);
    if (!summary) {
      summary = emptySessionSummary(rec.sessionId, rec.profile);
      sessions.set(rec.sessionId, summary);
    }
    summary.requests += 1;
    addUsage(summary, rec.usage, rec.model);
  }

  return Array.from(sessions.values()).sort(
    (a, b) => totalTokens(b) - totalTokens(a) || a.sessionId.localeCompare(b.sessionId),
  );
}

/** Tokens and cost of one slice of the usage: a profile, a day, a model, a project. */
export interface UsageSlice extends UsageTotals {
  requests: number;
}

/**
 * Where the tokens went, from one scan of the transcripts — everything a dashboard draws
 * and nothing that does not survive JSON: who spent (per profile), when (per day and
 * profile), on which model, in which project, and the heaviest sessions.
 */
export interface UsageReport {
  profiles: Array<UsageSlice & { profile: string; sessions: number; models: string[] }>;
  days: Array<UsageSlice & { day: string; profile: string }>;
  /** Every day (or hour) the window covers, oldest first, the ones with no usage too. */
  buckets: string[];
  models: Array<UsageSlice & { model: string }>;
  projects: Array<UsageSlice & { project: string }>;
  sessions: Array<UsageSlice & { sessionId: string; profile: string; project: string }>;
}

function emptySlice(): UsageSlice {
  return { requests: 0, inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
}

/** `2026-05-14` (or `2026-05-14T09`) in the machine's own time zone: the day the user lived it on. */
function localDay(ms: number, withHour = false): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  return withHour ? `${day}T${pad(d.getHours())}` : day;
}

/** Every day, or hour, from one moment to another, as `localDay` names them. */
function bucketsBetween(fromMs: number, toMs: number, byHour: boolean): string[] {
  const list: string[] = [];
  const at = new Date(fromMs);
  at.setMinutes(0, 0, 0);
  if (!byHour) at.setHours(0);

  while (at.getTime() <= toMs) {
    list.push(localDay(at.getTime(), byHour));
    if (byHour) at.setHours(at.getHours() + 1);
    else at.setDate(at.getDate() + 1);
  }

  // The hour the clocks go back happens twice, and is one bucket.
  return [...new Set(list)];
}

/** `byHour` splits `days` by the hour instead — `2026-05-14T09` — for a window of a day or two. */
export function usageReport(config: AimuxConfig, options: UsageOptions & { top?: number; byHour?: boolean } = {}): UsageReport {
  const top = options.top ?? 15;
  const profiles = new Map<string, UsageSlice & { profile: string; sessions: Set<string>; models: Set<string> }>();
  const days = new Map<string, UsageSlice & { day: string; profile: string }>();
  const models = new Map<string, UsageSlice & { model: string }>();
  const projects = new Map<string, UsageSlice & { project: string }>();
  const sessions = new Map<string, UsageSlice & { sessionId: string; profile: string; project: string }>();

  const slice = <K, T extends UsageSlice>(map: Map<K, T>, key: K, make: () => T): T => {
    let found = map.get(key);
    if (!found) {
      found = make();
      map.set(key, found);
    }
    return found;
  };

  for (const name of Object.keys(config.profiles)) {
    if (!options.profile || options.profile === name) {
      profiles.set(name, { ...emptySlice(), profile: name, sessions: new Set(), models: new Set() });
    }
  }

  const now = Date.now();
  let earliest = options.sinceMs ?? now;

  for (const rec of collectUsageRecords(config, options)) {
    if (rec.at < earliest) earliest = rec.at;

    const day = localDay(rec.at, options.byHour);
    // No profile's: at least say which tool's subscription it ran on.
    const who = rec.profile === 'unknown' && rec.cli === 'codex' ? 'unknown (codex)' : rec.profile;
    const profile = slice(profiles, who, () => ({ ...emptySlice(), profile: who, sessions: new Set<string>(), models: new Set<string>() }));
    profile.sessions.add(rec.sessionId);
    profile.models.add(rec.model);

    const touched: UsageSlice[] = [
      profile,
      slice(days, `${day}|${who}`, () => ({ ...emptySlice(), day, profile: who })),
      slice(models, rec.model, () => ({ ...emptySlice(), model: rec.model })),
      slice(projects, rec.project, () => ({ ...emptySlice(), project: rec.project })),
      slice(sessions, rec.sessionId, () => ({ ...emptySlice(), sessionId: rec.sessionId, profile: who, project: rec.project })),
    ];

    for (const each of touched) {
      each.requests += 1;
      addUsage(each, rec.usage, rec.model);
    }
  }

  const biggestFirst = <T extends UsageSlice>(list: Iterable<T>) => [...list].sort((a, b) => totalTokens(b) - totalTokens(a));
  // The heaviest by tokens, by cost and by requests: a reader may rank by any of the
  // three, and a project of few but costly tokens must not be missing when they do.
  const heaviest = <T extends UsageSlice>(list: Iterable<T>): T[] => {
    const all = biggestFirst(list);
    const picked = new Set(all.slice(0, top));
    for (const by of [(x: T) => x.estimatedCostUsd, (x: T) => x.requests]) {
      for (const each of [...all].sort((a, b) => by(b) - by(a)).slice(0, top)) picked.add(each);
    }

    return all.filter((each) => picked.has(each));
  };

  return {
    profiles: biggestFirst(profiles.values())
      .sort((a, b) => Number(a.profile.startsWith('unknown')) - Number(b.profile.startsWith('unknown')))
      .map(({ sessions: ran, models: used, ...rest }) => ({ ...rest, sessions: ran.size, models: [...used] })),
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day) || a.profile.localeCompare(b.profile)),
    buckets: bucketsBetween(earliest, now, options.byHour === true),
    models: biggestFirst(models.values()),
    projects: heaviest(projects.values()),
    sessions: heaviest(sessions.values()),
  };
}

export function totalTokens(summary: UsageTotals): number {
  return (
    summary.inputTokens +
    summary.cacheCreationInputTokens +
    summary.cacheReadInputTokens +
    summary.outputTokens
  );
}
