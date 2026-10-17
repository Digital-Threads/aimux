import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AimuxConfig, ProfileConfig } from '../types/index.js';
import { baseEnvFor, loadProfileEnv } from './run.js';
import { expandHome, getAimuxDir } from './paths.js';
import { adapterFor } from './adapters/index.js';
import { recordLimits } from './limitsHistory.js';

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

/** A Keychain lookup is a subprocess; cap it so a locked Keychain (which prompts)
 *  cannot hang a status table. */
const KEYCHAIN_TIMEOUT_MS = 4000;

/**
 * The Keychain service name Claude Code stores a config dir's credentials under:
 * the bare service when CLAUDE_CONFIG_DIR is unset, otherwise suffixed with the
 * first 8 hex of the sha256 of the NFC-normalized dir — the same rule claude
 * applies. aimux leaves CLAUDE_CONFIG_DIR unset for the source profile only, so
 * that, not the path, decides the suffix: a source at `~/.claude-main` still uses
 * the bare name. Exported because the naming is the part that can silently drift,
 * and a wrong name is indistinguishable from "not logged in".
 */
export function keychainService(profilePath: string, isSource: boolean): string {
  const base = 'Claude Code-credentials';
  if (isSource) return base;
  const hash = createHash('sha256').update(profilePath.normalize('NFC')).digest('hex');
  return `${base}-${hash.slice(0, 8)}`;
}

/** Whether the login Keychain holds claude credentials for this config dir. */
export function hasKeychainCredentials(profilePath: string, isSource: boolean): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('security', ['find-generic-password', '-s', keychainService(profilePath, isSource)], {
      timeout: KEYCHAIN_TIMEOUT_MS,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** Read the OAuth token macOS keeps in the login Keychain rather than on disk. */
function readKeychainToken(profilePath: string, isSource: boolean): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', keychainService(profilePath, isSource), '-w'],
      { encoding: 'utf-8', timeout: KEYCHAIN_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return JSON.parse(raw)?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Classify how a profile authenticates, mirroring StatusView.checkAuth's first
 * two branches (without the slow spawn probe): a non-source profile carrying a
 * 3rd-party endpoint env is `api`; a profile with stored OAuth credentials is
 * `oauth`; otherwise `none`. Only `oauth` profiles get a rate-limit probe.
 */
export function classifyProfile(
  profile: ProfileConfig,
  profilePath: string,
  hasKeychain: (profilePath: string, isSource: boolean) => boolean = hasKeychainCredentials,
): ProfileKind {
  if (!profile.is_source) {
    const env = loadProfileEnv(profile, profilePath);
    if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_BASE_URL) return 'api';
  }
  if (existsSync(join(profilePath, adapterFor(profile.cli).credentialsFile()))) return 'oauth';
  // On macOS there is no credentials file to find — claude keeps the token in the
  // login Keychain. Without this branch a logged-in non-source profile grades
  // 'none' and is dropped from the probe set before its token is ever read.
  if ((profile.cli ?? 'claude') === 'claude' && hasKeychain(profilePath, profile.is_source === true)) return 'oauth';
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

/**
 * Parse `GET /api/oauth/usage`, the endpoint claude's own `/usage` reads, into the
 * shape the headers produce. Utilization arrives there as a percent, not a fraction;
 * a plan with no 5-hour window sends that window as null.
 */
export function parseOAuthUsage(payload: unknown): RateLimitStatus | null {
  const windows = payload as { five_hour?: unknown; seven_day?: unknown } | null;
  const read = (raw: unknown) => {
    const w = raw as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (typeof w?.utilization !== 'number') return { pct: null, resetsAt: undefined };

    const resetsAt = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
    return {
      pct: Math.max(0, Math.min(100, Math.round(w.utilization))),
      resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined,
    };
  };

  const five = read(windows?.five_hour);
  const week = read(windows?.seven_day);
  if (five.pct === null && week.pct === null) return null;

  return { fiveHourPct: five.pct, weeklyPct: week.pct, fiveHourResetsAt: five.resetsAt, weeklyResetsAt: week.resetsAt };
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

/** A window's utilization for one-line messages; an unreported window is unknown, not 0%. */
export const fmtPct = (p: number | null) => (p === null ? '—' : `${p}%`);

/** Severity color for a utilization percent, shared by every view that shows it. */
export function pctColor(pct: number): 'green' | 'yellow' | 'red' {
  return pct >= 80 ? 'red' : pct >= 60 ? 'yellow' : 'green';
}

/**
 * The profile with the most room left, or null when no profile reported usable
 * numbers (probe failed, or nothing to probe) so the caller can fall back to its
 * normal choice instead of guessing.
 *
 * A profile is judged by its TIGHTEST window: 10% of the 5h window is worthless
 * if the weekly one is at 95%, since the session would die halfway through.
 * Windows the provider does not report are ignored rather than treated as free —
 * codex plans commonly have no 5h window at all. A fully spent window (100%)
 * takes the profile out of the running.
 */
export function pickFreestProfile(limits: Map<string, RateLimitProbe>): string | null {
  let best: { name: string; worstWindow: number } | null = null;

  for (const [name, probe] of limits) {
    const windows = [probe.status?.fiveHourPct, probe.status?.weeklyPct]
      .filter((p): p is number => typeof p === 'number');
    if (windows.length === 0) continue;

    const worstWindow = Math.max(...windows);
    if (worstWindow >= 100) continue;
    if (!best || worstWindow < best.worstWindow) best = { name, worstWindow };
  }

  return best?.name ?? null;
}

function readOAuthToken(profilePath: string, isSource: boolean): string | null {
  try {
    const raw = JSON.parse(readFileSync(join(profilePath, '.credentials.json'), 'utf-8'));
    const oauth = raw.claudeAiOauth ?? raw.claude_ai_oauth ?? raw;
    const token = oauth.accessToken ?? oauth.access_token ?? null;
    if (token) return token;
  } catch {
    // A missing credentials file is the normal case on macOS, not a failure.
  }
  return readKeychainToken(profilePath, isSource);
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

/**
 * Read a profile's windows from the endpoint claude's own `/usage` reads: a plain GET
 * that runs no model and costs no quota. It is undocumented, has a rate limit of its
 * own and answers a lapsed token with 429 rather than 401, so on anything but figures
 * or a 401 this falls back to the old probe: one tiny `max_tokens:1` request whose
 * headers carry the same windows, and which does answer a lapsed token with 401.
 */
async function fetchClaudeLimits(
  profilePath: string,
  isSource: boolean,
  signal: AbortSignal,
): Promise<RateLimitProbe> {
  const token = readOAuthToken(profilePath, isSource);
  if (!token) return { status: null, error: 'auth' };

  const auth = {
    authorization: `Bearer ${token}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
  };

  const usage = await fetch('https://api.anthropic.com/api/oauth/usage', {
    signal,
    headers: { ...auth, 'user-agent': 'aimux' },
  });
  if (usage.ok) {
    const status = parseOAuthUsage(await usage.json().catch(() => null));
    if (status) return { status };
  } else {
    // Unread, the body would hold its connection until garbage collection.
    await usage.body?.cancel().catch(() => {});
    if (usage.status === 401) return { status: null, error: 'auth' };
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', ...auth },
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

  const request = () => fetch('https://chatgpt.com/backend-api/codex/usage', {
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

  // Even so, Cloudflare's edge turns away the first requests on a new connection every
  // so often — an instant 403, sometimes several in a row — and then lets one through.
  // A refusal costs ~30 ms, so a handful of tries a beat apart before giving up.
  let res = await request();
  for (let tries = 1; res.status === 403 && tries < 5; tries++) {
    await new Promise((next) => setTimeout(next, 200));
    res = await request();
  }
  if (!res.ok) return { status: null, error: probeError(res.status) };
  const status = parseCodexUsage(await res.json());
  return status ? { status } : { status: null, error: 'unavailable' };
}

const RENEW_TIMEOUT_MS = 15_000;

// A login or endpoint claude takes from the environment ahead of its stored login:
// inherited from the shell, it makes `claude auth status` report that and renew nothing.
const ENV_LOGINS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL'];

/** The environment claude renews a profile's login in: the profile's own, no other login riding along. */
export function renewEnv(
  profile: ProfileConfig,
  profilePath: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const base = baseEnvFor(profile, profilePath, env);
  for (const key of ENV_LOGINS) delete base[key];

  return {
    ...base,
    ...loadProfileEnv(profile, profilePath),
    ...adapterFor('claude').configDirEnv(profilePath, profile.is_source === true),
  };
}

/**
 * Have claude renew a profile's login the way it does on start. `claude auth status`
 * swaps a lapsed access token for a fresh one without running a model, and the
 * refresh token stays claude's alone: aimux never writes credentials.
 */
function renewClaudeLogin(profile: ProfileConfig, profilePath: string): Promise<void> {
  return new Promise((done) => {
    // Never killed, and detached so a Ctrl-C of aimux does not reach it: a refresh cut
    // short can lose the new refresh token. Past the timeout aimux just stops waiting.
    const child = spawn('claude', ['auth', 'status', '--json'], {
      env: renewEnv(profile, profilePath),
      stdio: 'ignore',
      detached: true,
    });
    child.unref();

    const timer = setTimeout(done, RENEW_TIMEOUT_MS);
    const finish = () => {
      clearTimeout(timer);
      done();
    };
    child.on('error', finish);
    child.on('close', finish);
  });
}

// Tokens claude was asked to renew and left as they were: a login really gone. Asked
// again only once the token changes, so `status --watch` does not ask on every pass.
const unrenewable = new Set<string>();

/**
 * Probe a profile's live 5h/7d subscription windows, using whichever endpoint
 * its CLI exposes. Never throws: a failure comes back as `{ status: null }`
 * with a reason, because a status table must not die on a flaky network.
 */
export async function fetchRateLimits(
  profile: ProfileConfig,
  profilePath: string,
  options: { timeoutMs?: number; renew?: (profile: ProfileConfig, profilePath: string) => Promise<void> } = {},
): Promise<RateLimitProbe> {
  const cli = profile.cli ?? 'claude';
  if (classifyProfile(profile, profilePath) !== 'oauth' || !LIMIT_CAPABLE_CLIS.has(cli)) {
    return { status: null };
  }

  const attempt = async (): Promise<RateLimitProbe> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
    try {
      return cli === 'codex'
        ? await fetchCodexLimits(profilePath, controller.signal)
        : await fetchClaudeLimits(profilePath, profile.is_source === true, controller.signal);
    } catch {
      return { status: null, error: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  };

  // A busy API or a dropped connection answers differently a moment later, and the
  // figures are shown for minutes: worth one more try. A stale login is not, and
  // neither is a request that already waited out its whole timeout.
  const isSource = profile.is_source === true;
  // Read before the probe, not after: a token claude renews meanwhile must not look unchanged.
  const used = cli === 'claude' ? readOAuthToken(profilePath, isSource) : null;
  const startedAt = Date.now();
  const first = await attempt();

  // claude's access token lapses after about eight hours and only claude renews it,
  // on its next start: a profile left alone overnight read as logged out while claude
  // itself signed in without a word. Have claude renew it and ask again; a login that
  // is really gone leaves the token as it was and stays "auth".
  if (first.error === 'auth' && used && !unrenewable.has(used)) {
    await (options.renew ?? renewClaudeLogin)(profile, profilePath);
    if (readOAuthToken(profilePath, isSource) !== used) return attempt();

    unrenewable.add(used);
  }

  const failedFast = first.error === 'unavailable' && Date.now() - startedAt < 2000;

  return failedFast ? attempt() : first;
}

/** What `aimux status --json` prints: every subscription's windows and when they were read. */
export interface LimitsSnapshot {
  fetchedAt: number;
  profiles: Record<string, RateLimitProbe & { cli: string }>;
}

/**
 * Every subscription's windows, read now — or, within `maxAgeMs`, the last reading.
 *
 * Each probe is a request per subscription, and every claude session the Claude Code
 * mod runs in asks for these figures; the shared file under ~/.aimux keeps a dozen
 * open sessions to one probe every few minutes.
 */
export async function limitsSnapshot(
  config: AimuxConfig,
  maxAgeMs: number,
  now: number = Date.now(),
  probe: (profile: ProfileConfig, profilePath: string) => Promise<RateLimitProbe> = fetchRateLimits,
): Promise<LimitsSnapshot> {
  const cachePath = join(getAimuxDir(), 'limits-cache.json');
  const names = rateLimitProfiles(config.profiles);

  if (maxAgeMs > 0) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as LimitsSnapshot;
      // Only a reading of the same subscriptions, with no login since: a profile added,
      // removed or logged in again is news, and "login expired" must not outlive a login.
      const sameProfiles = Object.keys(cached.profiles).sort().join() === [...names].sort().join();
      const loggedInSince = names.some((name) => {
        const p = config.profiles[name];
        const credentials = join(expandHome(p.path), adapterFor(p.cli).credentialsFile());
        return (statSync(credentials, { throwIfNoEntry: false })?.mtimeMs ?? 0) > cached.fetchedAt;
      });
      if (sameProfiles && !loggedInSince && cached.fetchedAt <= now && now - cached.fetchedAt < maxAgeMs) return cached;
    } catch {
      // no reading yet, or a broken one: probe
    }
  }

  const profiles = Object.fromEntries(await Promise.all(names.map(async (name) => {
    const p = config.profiles[name];
    return [name, { cli: p.cli ?? 'claude', ...(await probe(p, expandHome(p.path))) }] as const;
  })));
  const snapshot: LimitsSnapshot = { fetchedAt: now, profiles };
  recordLimits(snapshot);

  // Written aside and renamed, so a session reading it never sees half a file.
  try {
    const tmp = `${cachePath}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(snapshot));
    renameSync(tmp, cachePath);
  } catch {
    // an unwritable ~/.aimux costs only the sharing
  }

  return snapshot;
}
