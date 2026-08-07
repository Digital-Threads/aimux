import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProfileConfig } from '../types/index.js';
import { loadProfileEnv } from './run.js';
import { expandHome } from './paths.js';
import { adapterFor } from './adapters/index.js';

/** Live subscription rate-limit windows, as whole-percent utilization.
 *  A window is `null` when the provider did not report it — a plan can genuinely
 *  have no 5h window, and "unknown" must not be rendered as "0% used". */
export interface RateLimitStatus {
  fiveHourPct: number | null;
  weeklyPct: number | null;
  fiveHourResetsAt?: number;
  weeklyResetsAt?: number;
  status?: string;
}

/** Outcome of one probe. `status === null` means no numbers came back, and
 *  `error` says why — stale credentials read very differently from a flaky
 *  network, and only the former is something the user can act on. */
export interface RateLimitProbe {
  status: RateLimitStatus | null;
  error?: 'auth' | 'unavailable';
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
    fiveHourPct: five,
    weeklyPct: week,
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
  if (existsSync(join(profilePath, adapterFor(profile.cli).credentialsFile()))) return 'oauth';
  return profile.is_source ? 'oauth' : 'none';
}

/** CLIs that expose their own subscription windows. Anything else (gemini today)
 *  is left alone rather than probed against an API that knows nothing about it. */
const LIMIT_CAPABLE_CLIS = new Set(['claude', 'codex']);

/**
 * Which profiles are worth a rate-limit probe: logged-in subscription profiles
 * of a CLI that reports windows. API-endpoint profiles bill per token and have
 * no 5h/7d windows at all, so they are excluded by `classifyProfile`.
 */
export function rateLimitProfiles(profiles: Record<string, ProfileConfig>): string[] {
  return Object.entries(profiles)
    .filter(([, p]) => LIMIT_CAPABLE_CLIS.has(p.cli ?? 'claude')
      && classifyProfile(p, expandHome(p.path)) === 'oauth')
    .map(([name]) => name);
}

/** Window lengths as reported by the ChatGPT usage endpoint, in seconds. */
const CODEX_FIVE_HOUR_SECONDS = 5 * 3600;
const CODEX_WEEK_SECONDS = 7 * 24 * 3600;

/**
 * Parse `GET /backend-api/codex/usage` into the same shape the claude headers
 * produce. Windows are matched on `limit_window_seconds`, never on which slot
 * they arrive in: on a plan with no 5h window the weekly one shows up as
 * `primary_window`, so trusting the slot order would label it 5h.
 */
export function parseCodexUsage(payload: unknown): RateLimitStatus | null {
  const limit = (payload as { rate_limit?: unknown } | null)?.rate_limit as
    | { primary_window?: unknown; secondary_window?: unknown }
    | undefined;
  if (!limit) return null;

  const out: RateLimitStatus = { fiveHourPct: null, weeklyPct: null };
  for (const raw of [limit.primary_window, limit.secondary_window]) {
    const w = raw as { used_percent?: number; limit_window_seconds?: number; reset_at?: number } | null;
    if (!w || typeof w.used_percent !== 'number') continue;
    const pct = Math.max(0, Math.min(100, Math.round(w.used_percent)));
    const resetsAt = typeof w.reset_at === 'number' ? w.reset_at * 1000 : undefined;
    if (w.limit_window_seconds === CODEX_FIVE_HOUR_SECONDS) {
      out.fiveHourPct = pct;
      out.fiveHourResetsAt = resetsAt;
    } else if (w.limit_window_seconds === CODEX_WEEK_SECONDS) {
      out.weeklyPct = pct;
      out.weeklyResetsAt = resetsAt;
    }
  }
  return out.fiveHourPct === null && out.weeklyPct === null ? null : out;
}

/**
 * When a window frees up, in the shortest form that is still unambiguous: a
 * clock time within the next day (what a 5h window always is), a calendar date
 * beyond that (a weekly window, where "14:07" alone would not say which day).
 */
export function formatResetAt(resetsAt: number | undefined, now = Date.now()): string {
  if (resetsAt === undefined) return '—';
  if (resetsAt <= now) return 'now';
  const d = new Date(resetsAt);
  return resetsAt - now < 24 * 3600_000
    ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Severity color for a utilization percent, shared by every view that shows it. */
export function pctColor(pct: number): 'green' | 'yellow' | 'red' {
  return pct >= 80 ? 'red' : pct >= 60 ? 'yellow' : 'green';
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

/** Read codex's stored ChatGPT tokens. Unlike claude, the account id is part of
 *  the request, so a profile's numbers can never come from another account. */
function readCodexAuth(profilePath: string): { token: string; accountId?: string } | null {
  try {
    const raw = JSON.parse(readFileSync(join(profilePath, 'auth.json'), 'utf-8'));
    const token = raw.tokens?.access_token;
    return token ? { token, accountId: raw.tokens?.account_id } : null;
  } catch {
    return null;
  }
}

/** HTTP 401 means the stored token went stale — the user can fix that by running
 *  the CLI once (it refreshes on start) or re-authenticating. Anything else,
 *  403 included, is infrastructure saying no; that is not the user's to fix and
 *  must not be reported as a login problem. */
export function probeError(httpStatus: number): 'auth' | 'unavailable' {
  return httpStatus === 401 ? 'auth' : 'unavailable';
}

/** Probe Anthropic: one tiny `max_tokens:1` request, only the headers are read. */
async function fetchClaudeLimits(profilePath: string, signal: AbortSignal): Promise<RateLimitProbe> {
  const token = readOAuthToken(profilePath);
  if (!token) return { status: null, error: 'auth' };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
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
  const status = parseRateLimitHeaders(headers);
  return status ? { status } : { status: null, error: probeError(res.status) };
}

/** Probe the ChatGPT usage endpoint codex itself uses. A plain GET — it reports
 *  the windows without running a model, so checking costs no quota. */
async function fetchCodexLimits(profilePath: string, signal: AbortSignal): Promise<RateLimitProbe> {
  const auth = readCodexAuth(profilePath);
  if (!auth) return { status: null, error: 'auth' };

  const res = await fetch('https://chatgpt.com/backend-api/codex/usage', {
    signal,
    headers: {
      authorization: `Bearer ${auth.token}`,
      ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
      accept: 'application/json',
      // Required: the endpoint sits behind Cloudflare, which answers an
      // agent-less request with a 403 HTML page. Any non-empty value works, so
      // we identify honestly instead of impersonating the codex CLI.
      'user-agent': 'aimux',
    },
  });
  if (!res.ok) return { status: null, error: probeError(res.status) };
  const status = parseCodexUsage(await res.json());
  return status ? { status } : { status: null, error: 'unavailable' };
}

/**
 * Probe a profile's live 5h/7d subscription windows, using whichever endpoint
 * its CLI exposes. Never throws: a failure comes back as `{ status: null }`
 * with a reason, because a status table must not die on a flaky network.
 */
export async function fetchRateLimits(
  profile: ProfileConfig,
  profilePath: string,
  options: { timeoutMs?: number } = {},
): Promise<RateLimitProbe> {
  const cli = profile.cli ?? 'claude';
  if (classifyProfile(profile, profilePath) !== 'oauth' || !LIMIT_CAPABLE_CLIS.has(cli)) {
    return { status: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    return cli === 'codex'
      ? await fetchCodexLimits(profilePath, controller.signal)
      : await fetchClaudeLimits(profilePath, controller.signal);
  } catch {
    return { status: null, error: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
