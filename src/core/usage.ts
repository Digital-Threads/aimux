import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AimuxConfig } from '../types/index.js';
import { expandHome } from './paths.js';
import { loadSessionHistory } from './sessionHistory.js';
import { buildProfileSessionMap } from './profileSessionMap.js';

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
    usage?: Partial<{
      input_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      output_tokens: number;
      estimated_cost_usd: number;
      cost_usd: number;
    }>;
  };
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

function addUsage(summary: ProfileUsageSummary, usage: NonNullable<TranscriptLine['message']>['usage']): void {
  if (!usage) return;
  summary.inputTokens += usage.input_tokens ?? 0;
  summary.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
  summary.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
  summary.outputTokens += usage.output_tokens ?? 0;
  summary.estimatedCostUsd += usage.estimated_cost_usd ?? usage.cost_usd ?? 0;
}

function resolveLineTime(line: TranscriptLine, fallbackMs: number): number {
  if (typeof line.timestamp === 'string') {
    const parsed = Date.parse(line.timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallbackMs;
}

function requestKey(sessionId: string, line: TranscriptLine): string {
  if (line.requestId) return `${sessionId}:request:${line.requestId}`;
  if (line.message?.id) return `${sessionId}:message:${line.message.id}`;
  if (line.uuid) return `${sessionId}:uuid:${line.uuid}`;
  return `${sessionId}:unknown:${Math.random()}`;
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

export function summarizeUsage(config: AimuxConfig, options: UsageOptions = {}): ProfileUsageSummary[] {
  const projectsRoot = join(expandHome(config.shared_source), 'projects');
  const summaries = new Map<string, ProfileUsageSummary>();
  const sessionSets = new Map<string, Set<string>>();
  const seenRequests = new Set<string>();
  const history = loadSessionHistory();
  const profileMap = buildProfileSessionMap(config);

  for (const profile of Object.keys(config.profiles)) {
    summaries.set(profile, emptySummary(profile));
    sessionSets.set(profile, new Set<string>());
  }

  if (!existsSync(projectsRoot)) {
    return Array.from(summaries.values()).filter((s) => !options.profile || s.profile === options.profile);
  }

  let cwdDirs: string[];
  try {
    cwdDirs = readdirSync(projectsRoot);
  } catch {
    return Array.from(summaries.values()).filter((s) => !options.profile || s.profile === options.profile);
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

      const fallbackSessionId = file.replace(/\.jsonl$/, '');
      const fallbackProfile =
        history.get(fallbackSessionId)?.profile ?? profileMap.get(fallbackSessionId)?.profile ?? 'unknown';
      let lines: string[];
      try {
        lines = readFileSync(filePath, 'utf-8').split('\n');
      } catch {
        continue;
      }

      for (const raw of lines) {
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

        const key = requestKey(sessionId, line);
        if (seenRequests.has(key)) continue;
        seenRequests.add(key);

        if (!summaries.has(profile)) {
          summaries.set(profile, emptySummary(profile));
          sessionSets.set(profile, new Set<string>());
        }
        const summary = summaries.get(profile)!;
        summary.requests += 1;
        addUsage(summary, usage);
        const model = formatModel(line.message?.model);
        summary.models.set(model, (summary.models.get(model) ?? 0) + 1);
        sessionSets.get(profile)!.add(sessionId);
      }
    }
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
      const totalA = a.inputTokens + a.cacheCreationInputTokens + a.cacheReadInputTokens + a.outputTokens;
      const totalB = b.inputTokens + b.cacheCreationInputTokens + b.cacheReadInputTokens + b.outputTokens;
      return totalB - totalA || a.profile.localeCompare(b.profile);
    });
}

export function totalTokens(summary: UsageTotals): number {
  return (
    summary.inputTokens +
    summary.cacheCreationInputTokens +
    summary.cacheReadInputTokens +
    summary.outputTokens
  );
}
