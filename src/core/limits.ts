import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProfileConfig } from '../types/index.js';
import { loadProfileEnv } from './run.js';

/** Live subscription rate-limit windows, as whole-percent utilization. */
export interface RateLimitStatus {
  fiveHourPct: number;
  weeklyPct: number;
  fiveHourResetsAt?: number;
  weeklyResetsAt?: number;
  status?: string;
}

export type ProfileKind = 'oauth' | 'api' | 'none';

function toPercent(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n * 100)));
}

function toResetMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n * 1000 : undefined;
}

/**
 * Parse the `anthropic-ratelimit-unified-*` response headers (see plan spike
 * result) into percent utilization for the 5h and 7d subscription windows.
 * Returns null when neither window's utilization header is present.
 */
export function parseRateLimitHeaders(
  headers: Record<string, string>,
): RateLimitStatus | null {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const get = (name: string) => lower[name];

  const five = toPercent(get('anthropic-ratelimit-unified-5h-utilization'));
  const week = toPercent(get('anthropic-ratelimit-unified-7d-utilization'));
  if (five === null && week === null) return null;

  return {
    fiveHourPct: five ?? 0,
    weeklyPct: week ?? 0,
    fiveHourResetsAt: toResetMs(get('anthropic-ratelimit-unified-5h-reset')),
    weeklyResetsAt: toResetMs(get('anthropic-ratelimit-unified-7d-reset')),
    status: get('anthropic-ratelimit-unified-status'),
  };
}

/**
 * Classify how a profile authenticates, mirroring StatusView.checkAuth's first
 * two branches (without the slow spawn probe): a non-source profile carrying a
 * 3rd-party endpoint env is `api`; a profile with stored OAuth credentials is
 * `oauth`; otherwise `none`. Only `oauth` profiles get a rate-limit probe.
 */
export function classifyProfile(profile: ProfileConfig, profilePath: string): ProfileKind {
  if (!profile.is_source) {
    const env = loadProfileEnv(profile, profilePath);
    if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_BASE_URL) return 'api';
  }
  if (existsSync(join(profilePath, '.credentials.json'))) return 'oauth';
  return profile.is_source ? 'oauth' : 'none';
}

function readOAuthToken(profilePath: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(profilePath, '.credentials.json'), 'utf-8'));
    const oauth = raw.claudeAiOauth ?? raw.claude_ai_oauth ?? raw;
    return oauth.accessToken ?? oauth.access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Probe Anthropic for the live 5h/7d rate-limit windows of an OAuth profile.
 * One tiny `max_tokens:1` request; only the response headers are used. Returns
 * null for non-oauth profiles, missing creds, network errors, or timeout.
 */
export async function fetchRateLimits(
  profile: ProfileConfig,
  profilePath: string,
  options: { timeoutMs?: number } = {},
): Promise<RateLimitStatus | null> {
  if (classifyProfile(profile, profilePath) !== 'oauth') return null;
  const token = readOAuthToken(profilePath);
  if (!token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return parseRateLimitHeaders(headers);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
