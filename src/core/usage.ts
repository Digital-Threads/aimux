import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AimuxConfig } from '../types/index.js';
import { expandHome } from './paths.js';
import { loadSessionHistory } from './sessionHistory.js';
import { buildProfileSessionMap } from './profileSessionMap.js';
import { parseSessionJsonl, quickFirstLineType } from './sessionScanner.js';
import { estimateCost } from './pricing.js';

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

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  requestId?: string;
  uuid?: string;
  sessionId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: UsagePayload;
  };
}

interface UsagePayload {
  input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  output_tokens?: unknown;
  estimated_cost_usd?: unknown;
  cost_usd?: unknown;
}

function parseJson(line: string): TranscriptLine | null {
  try {
    return JSON.parse(line) as TranscriptLine;
  } catch {
    return null;
  }
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

function resolveLineTime(line: TranscriptLine, fallbackMs: number): number {
  if (typeof line.timestamp === 'string') {
    const parsed = Date.parse(line.timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallbackMs;
}

function requestKey(sessionId: string, line: TranscriptLine, lineIndex: number): string {
  if (line.requestId) return `request:${line.requestId}`;
  if (line.message?.id) return `${sessionId}:message:${line.message.id}`;
  if (line.uuid) return `${sessionId}:uuid:${line.uuid}`;
  return `${sessionId}:line:${lineIndex}`;
}

function formatModel(model: string | undefined): string {
  return model && model.trim() ? model : 'unknown';
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
  sessionId: string;
  model: string;
  usage: UsagePayload;
}

// Single scan of all transcripts → deduplicated per-request usage records. Shared by
// summarizeUsage (group by profile) and usageBySession (group by session) so both stay
// in sync and the scan/dedup logic lives in one place.
function collectUsageRecords(config: AimuxConfig, options: UsageOptions = {}): UsageRecord[] {
  const projectsRoot = join(expandHome(config.shared_source), 'projects');
  const records: UsageRecord[] = [];
  if (!existsSync(projectsRoot)) return records;

  const seenRequests = new Set<string>();
  const history = loadSessionHistory();
  const profileMap = buildProfileSessionMap(config);

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
      if (options.sinceMs !== undefined && stat.mtimeMs < options.sinceMs) continue;
      if (quickFirstLineType(filePath) === 'queue-operation') continue;
      if (parseSessionJsonl(filePath, stat.size).isSubagent) continue;

      const fallbackSessionId = file.replace(/\.jsonl$/, '');
      const fallbackProfile =
        history.get(fallbackSessionId)?.profile ?? profileMap.get(fallbackSessionId)?.profile ?? 'unknown';
      let lines: string[];
      try {
        lines = readFileSync(filePath, 'utf-8').split('\n');
      } catch {
        continue;
      }

      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (!raw) continue;
        const line = parseJson(raw);
        const usage = line?.message?.usage;
        if (!line || line.type !== 'assistant' || !usage) continue;
        const lineMs = resolveLineTime(line, stat.mtimeMs);
        if (options.sinceMs !== undefined && lineMs < options.sinceMs) continue;

        const sessionId = line.sessionId ?? fallbackSessionId;
        const profile =
          history.get(sessionId)?.profile ?? profileMap.get(sessionId)?.profile ?? fallbackProfile;
        if (options.profile && profile !== options.profile) continue;

        const key = requestKey(sessionId, line, i);
        if (seenRequests.has(key)) continue;
        seenRequests.add(key);

        records.push({ profile, sessionId, model: formatModel(line.message?.model), usage });
      }
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

export function totalTokens(summary: UsageTotals): number {
  return (
    summary.inputTokens +
    summary.cacheCreationInputTokens +
    summary.cacheReadInputTokens +
    summary.outputTokens
  );
}
