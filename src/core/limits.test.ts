import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { ProfileConfig } from '../types/index.js';
import type { AimuxConfig } from '../types/index.js';
import { getAimuxDir, setAimuxDir } from './paths.js';
import { parseRateLimitHeaders, parseCodexUsage, pctColor, probeError, rateLimitProfiles, formatResetAt, pickFreestProfile, keychainService, classifyProfile, limitsSnapshot, fetchRateLimits, parseOAuthUsage, renewEnv } from './limits.js';

// Real header keys captured from a live HTTP 200 probe (see plan spike result).
const REAL = {
  'anthropic-ratelimit-unified-5h-utilization': '0.42',
  'anthropic-ratelimit-unified-5h-reset': '1780762200',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-7d-utilization': '0.16',
  'anthropic-ratelimit-unified-7d-reset': '1781229600',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-status': 'allowed',
};

describe('parseRateLimitHeaders', () => {
  it('converts utilization fractions to whole-percent values', () => {
    const r = parseRateLimitHeaders(REAL)!;
    expect(r.fiveHourPct).toBe(42);
    expect(r.weeklyPct).toBe(16);
  });

  it('converts epoch-second reset stamps to milliseconds', () => {
    const r = parseRateLimitHeaders(REAL)!;
    expect(r.fiveHourResetsAt).toBe(1780762200 * 1000);
    expect(r.weeklyResetsAt).toBe(1781229600 * 1000);
  });

  it('carries the overall status when present', () => {
    expect(parseRateLimitHeaders(REAL)!.status).toBe('allowed');
  });

  it('is case-insensitive on header names', () => {
    const upper = { 'ANTHROPIC-RATELIMIT-UNIFIED-5H-UTILIZATION': '0.5' };
    expect(parseRateLimitHeaders(upper)?.fiveHourPct).toBe(50);
  });

  it('clamps utilization above 1.0 to 100%', () => {
    const over = { 'anthropic-ratelimit-unified-5h-utilization': '1.4' };
    expect(parseRateLimitHeaders(over)?.fiveHourPct).toBe(100);
  });

  it('returns null when no unified utilization headers are present', () => {
    expect(parseRateLimitHeaders({ 'content-type': 'application/json' })).toBeNull();
  });

  it('reports a missing window as null, not 0% — no data is not "nothing used"', () => {
    const onlyFive = { 'anthropic-ratelimit-unified-5h-utilization': '0.3' };
    const r = parseRateLimitHeaders(onlyFive)!;
    expect(r.fiveHourPct).toBe(30);
    expect(r.weeklyPct).toBeNull();
    expect(r.weeklyResetsAt).toBeUndefined();
  });
});

describe('keychainService', () => {
  // claude drops the suffix when CLAUDE_CONFIG_DIR is unset, and aimux leaves it
  // unset for exactly one profile: the source — wherever its path points.
  it('uses the bare service name for the source profile, even at a non-default path', () => {
    expect(keychainService('/Users/example/.claude-main', true)).toBe('Claude Code-credentials');
  });

  it('still suffixes a non-source profile at ~/.claude, because aimux exports CLAUDE_CONFIG_DIR for it', () => {
    expect(keychainService(join(homedir(), '.claude'), false)).not.toBe('Claude Code-credentials');
  });

  // Pinned rather than recomputed: restating the hash in the test would assert
  // nothing, and a drifted naming scheme is indistinguishable from "not logged in".
  it('suffixes any other config dir with the first 8 hex of its sha256', () => {
    expect(keychainService('/Users/example/.aimux/profiles/work', false)).toBe(
      'Claude Code-credentials-8c2e5287',
    );
  });

  // macOS hands paths back decomposed (NFD); claude normalizes to NFC before
  // hashing, so a non-ASCII home dir must hash the same either way.
  it('hashes the NFC form of the path, as claude does', () => {
    expect(keychainService('/Users/José/.aimux/profiles/work', false)).toBe(
      keychainService('/Users/José/.aimux/profiles/work', false),
    );
  });

  it('gives two profiles two different service names, so one cannot read the other\'s quota', () => {
    expect(keychainService('/Users/example/.aimux/profiles/work', false)).not.toBe(
      keychainService('/Users/example/.aimux/profiles/personal', false),
    );
  });
});

describe('classifyProfile', () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aimux-classify-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const never = () => false;
  const always = () => true;

  // The regression this guards: on macOS there is no .credentials.json to find, so
  // a logged-in profile graded 'none' here is dropped from the probe set before its
  // token is ever read, and its 5h/7d column renders a permanent em-dash.
  it('grades a non-source profile with Keychain credentials as oauth', () => {
    expect(classifyProfile({ cli: 'claude', path: dir }, dir, always)).toBe('oauth');
  });

  it('tells the Keychain lookup whether the profile is the source — that decides the service name', () => {
    const seen: boolean[] = [];
    const spy = (_path: string, isSource: boolean) => { seen.push(isSource); return false; };
    classifyProfile({ cli: 'claude', path: dir }, dir, spy);
    classifyProfile({ cli: 'claude', path: dir, is_source: true }, dir, spy);
    expect(seen).toEqual([false, true]);
  });

  it('still grades a profile with neither a credentials file nor a Keychain entry as none', () => {
    expect(classifyProfile({ cli: 'claude', path: dir }, dir, never)).toBe('none');
  });

  it('does not consult the Keychain for codex, whose token lives in auth.json', () => {
    expect(classifyProfile({ cli: 'codex', path: dir }, dir, always)).toBe('none');
  });

  it('still prefers a credentials file when one exists', () => {
    writeFileSync(join(dir, '.credentials.json'), '{}');
    expect(classifyProfile({ cli: 'claude', path: dir }, dir, never)).toBe('oauth');
  });

  it('still classifies a 3rd-party API profile as api, ahead of any credential lookup', () => {
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_BASE_URL=https://api.example.com\n');
    expect(classifyProfile({ cli: 'claude', path: dir }, dir, always)).toBe('api');
  });
});

describe('pctColor', () => {
  it('escalates green -> yellow -> red at 60% and 80%', () => {
    expect(pctColor(0)).toBe('green');
    expect(pctColor(59)).toBe('green');
    expect(pctColor(60)).toBe('yellow');
    expect(pctColor(79)).toBe('yellow');
    expect(pctColor(80)).toBe('red');
    expect(pctColor(100)).toBe('red');
  });
});

describe('rateLimitProfiles', () => {
  let dir: string;
  const profile = (over: Partial<ProfileConfig>): ProfileConfig => ({ cli: 'claude', path: dir, ...over });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aimux-limits-'));
    writeFileSync(join(dir, '.credentials.json'), '{}');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('selects claude subscription profiles', () => {
    expect(rateLimitProfiles({ work: profile({}) })).toEqual(['work']);
  });

  it('includes a logged-in codex profile — codex reports its own windows via the ChatGPT usage endpoint', () => {
    writeFileSync(join(dir, 'auth.json'), '{}');
    expect(rateLimitProfiles({ cx: profile({ cli: 'codex' }) })).toEqual(['cx']);
  });

  it('skips CLIs with no limits endpoint of their own instead of probing them against the wrong API', () => {
    expect(rateLimitProfiles({ gm: profile({ cli: 'gemini' }) })).toEqual([]);
  });

  it('skips a codex profile that has not logged in', () => {
    expect(rateLimitProfiles({ cx: profile({ cli: 'codex' }) })).toEqual([]);
  });

  it('skips profiles with no stored credentials', () => {
    const empty = mkdtempSync(join(tmpdir(), 'aimux-limits-empty-'));
    try {
      expect(rateLimitProfiles({ fresh: { cli: 'claude', path: empty } })).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('skips 3rd-party API profiles — they bill per token and have no 5h/7d subscription windows', () => {
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_BASE_URL=https://api.example.com\n');
    expect(rateLimitProfiles({ api: profile({}) })).toEqual([]);
  });
});

// Captured from a live `GET https://chatgpt.com/backend-api/codex/usage` on a
// prolite plan: the ONLY window it reports is the weekly one, and it arrives as
// `primary_window` — so windows must be matched on limit_window_seconds, never
// on which slot they occupy.
const CODEX_USAGE = {
  plan_type: 'prolite',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 29,
      limit_window_seconds: 604800,
      reset_after_seconds: 501969,
      reset_at: 1786620443,
    },
    secondary_window: null,
  },
};

describe('parseCodexUsage', () => {
  it('maps a window by its length, not by its slot', () => {
    const r = parseCodexUsage(CODEX_USAGE)!;
    expect(r.weeklyPct).toBe(29);
    expect(r.weeklyResetsAt).toBe(1786620443 * 1000);
    // No 5h window was reported — that is unknown, not zero.
    expect(r.fiveHourPct).toBeNull();
  });

  it('reads both windows when the plan has a 5h one', () => {
    const both = {
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: 1786600000 },
        secondary_window: { used_percent: 47, limit_window_seconds: 604800, reset_at: 1786620443 },
      },
    };
    const r = parseCodexUsage(both)!;
    expect(r.fiveHourPct).toBe(12);
    expect(r.fiveHourResetsAt).toBe(1786600000 * 1000);
    expect(r.weeklyPct).toBe(47);
  });

  it('rounds fractional percentages', () => {
    const frac = { rate_limit: { primary_window: { used_percent: 29.6, limit_window_seconds: 604800 } } };
    expect(parseCodexUsage(frac)!.weeklyPct).toBe(30);
  });

  it('returns null for a payload with no usable window', () => {
    expect(parseCodexUsage({ rate_limit: { primary_window: null, secondary_window: null } })).toBeNull();
    expect(parseCodexUsage({})).toBeNull();
    expect(parseCodexUsage(null)).toBeNull();
  });

  it('ignores a window of an unrecognized length rather than guessing', () => {
    const odd = { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 86400 } } };
    expect(parseCodexUsage(odd)).toBeNull();
  });
});

describe('probeError', () => {
  it('treats only 401 as a login problem', () => {
    expect(probeError(401)).toBe('auth');
  });

  it('does not blame the login for a 403 — the codex endpoint sits behind Cloudflare, which answers an agent-less request with 403 even on a perfectly valid token', () => {
    expect(probeError(403)).toBe('unavailable');
  });

  it('treats server-side failures as unavailable', () => {
    for (const code of [429, 500, 502, 503]) expect(probeError(code)).toBe('unavailable');
  });
});

describe('formatResetAt', () => {
  const now = Date.UTC(2026, 7, 7, 12, 0, 0);

  it('shows a clock time for a window that frees up within a day — that is the whole answer for a 5h window', () => {
    expect(formatResetAt(now + 2 * 3600_000, now)).toMatch(/^\d{2}:\d{2}$/);
  });

  it('shows a calendar date once the reset is more than a day out, where a bare clock time would be ambiguous', () => {
    expect(formatResetAt(now + 3 * 86_400_000, now)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('says "now" for a window that has already rolled over rather than printing a past time', () => {
    expect(formatResetAt(now - 60_000, now)).toBe('now');
  });

  it('returns an em-dash when the provider gave no reset stamp', () => {
    expect(formatResetAt(undefined, now)).toBe('—');
  });
});

describe('pickFreestProfile', () => {
  const probe = (five: number | null, week: number | null) => ({ status: { fiveHourPct: five, weeklyPct: week } });

  it('picks the profile whose tightest window has the most headroom', () => {
    // `b` looks better on the 5h window alone, but its weekly window is nearly
    // spent — picking on one window would strand the session mid-task.
    const limits = new Map([
      ['a', probe(40, 30)],
      ['b', probe(10, 95)],
      ['c', probe(50, 55)],
    ]);
    expect(pickFreestProfile(limits)).toBe('a');
  });

  it('judges a profile on the windows it actually has — codex reports no 5h window', () => {
    const limits = new Map([['cx', probe(null, 20)], ['dt', probe(35, 35)]]);
    expect(pickFreestProfile(limits)).toBe('cx');
  });

  it('skips an exhausted profile even when it is otherwise the freest', () => {
    const limits = new Map([['a', probe(100, 0)], ['b', probe(70, 70)]]);
    expect(pickFreestProfile(limits)).toBe('b');
  });

  it('returns null when nothing has usable numbers, so the caller can fall back', () => {
    expect(pickFreestProfile(new Map([['a', { status: null, error: 'auth' as const }]]))).toBeNull();
    expect(pickFreestProfile(new Map())).toBeNull();
    // Both windows unknown is not the same as both windows free.
    expect(pickFreestProfile(new Map([['a', probe(null, null)]]))).toBeNull();
  });
});

describe('limitsSnapshot', () => {
  let root: string;
  let originalAimuxDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aimux-snapshot-'));
    originalAimuxDir = getAimuxDir();
    setAimuxDir(join(root, '.aimux'));
    mkdirSync(join(root, '.aimux'), { recursive: true });
  });
  afterEach(() => {
    setAimuxDir(originalAimuxDir);
    rmSync(root, { recursive: true, force: true });
  });

  function config(): AimuxConfig {
    for (const name of ['dt', 'cx']) mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, 'dt', '.credentials.json'), '{}');
    writeFileSync(join(root, 'cx', 'auth.json'), '{}');
    return {
      version: 1,
      shared_source: join(root, 'src'),
      private: [],
      profiles: {
        dt: { cli: 'claude', path: join(root, 'dt') },
        cx: { cli: 'codex', path: join(root, 'cx') },
      },
    };
  }

  // Later than the credentials the tests write, as a real reading always is.
  const T = Date.now() + 60_000;

  const counting = () => {
    const probed: string[] = [];
    const probe = async (_p: ProfileConfig, path: string) => {
      probed.push(path.endsWith('dt') ? 'dt' : 'cx');
      return { status: { fiveHourPct: 10, weeklyPct: 20 } };
    };
    return { probed, probe };
  };

  it('reads every subscription, with its CLI, and remembers when', async () => {
    const { probe } = counting();
    const snapshot = await limitsSnapshot(config(), 0, T, probe);

    expect(snapshot).toEqual({
      fetchedAt: T,
      profiles: {
        dt: { cli: 'claude', status: { fiveHourPct: 10, weeklyPct: 20 } },
        cx: { cli: 'codex', status: { fiveHourPct: 10, weeklyPct: 20 } },
      },
    });
    expect(JSON.parse(readFileSync(join(root, '.aimux', 'limits-cache.json'), 'utf-8'))).toEqual(snapshot);
  });

  it('shares one probe between callers while the figures are fresh enough', async () => {
    // Every open claude session asks; only the first one in a while should probe.
    const { probed, probe } = counting();
    const cfg = config();

    await limitsSnapshot(cfg, 240_000, T, probe);
    const again = await limitsSnapshot(cfg, 240_000, T + 199_000, probe);
    expect(probed).toEqual(['dt', 'cx']);
    expect(again.fetchedAt).toBe(T);

    await limitsSnapshot(cfg, 240_000, T + 299_000, probe);
    expect(probed).toHaveLength(4);
  });

  it('probes again when the subscriptions changed since the reading', async () => {
    const { probed, probe } = counting();
    const cfg = config();
    await limitsSnapshot(cfg, 240_000, T, probe);

    delete cfg.profiles.cx;
    const again = await limitsSnapshot(cfg, 240_000, T + 1_000, probe);
    expect(Object.keys(again.profiles)).toEqual(['dt']);
    expect(probed).toEqual(['dt', 'cx', 'dt']);
  });

  it('probes again once a subscription logged in since the reading', async () => {
    // A fresh login must not keep showing "login expired" for minutes.
    const { probed, probe } = counting();
    const cfg = config();
    await limitsSnapshot(cfg, 240_000, T, probe);

    utimesSync(join(root, 'dt', '.credentials.json'), new Date(T + 5_000), new Date(T + 5_000));
    await limitsSnapshot(cfg, 240_000, T + 10_000, probe);
    expect(probed).toHaveLength(4);
  });

  it('shares the reading of a login kept in the Keychain too, with no credentials file', async () => {
    // On macOS claude stores no .credentials.json; that must not cost a probe per caller.
    const { probed, probe } = counting();
    const cfg = config();
    cfg.profiles.dt.is_source = true;
    rmSync(join(root, 'dt', '.credentials.json'));

    await limitsSnapshot(cfg, 240_000, T, probe);
    await limitsSnapshot(cfg, 240_000, T + 1_000, probe);
    expect(probed).toEqual(['dt', 'cx']);
  });

  it('always probes when asked for no cache, and survives a broken one', async () => {
    const { probed, probe } = counting();
    const cfg = config();
    writeFileSync(join(root, '.aimux', 'limits-cache.json'), '{"fetchedAt": 99');

    await limitsSnapshot(cfg, 240_000, T, probe);
    await limitsSnapshot(cfg, 0, T + 1, probe);
    expect(probed).toHaveLength(4);
  });
});

describe('fetchRateLimits — codex', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aimux-codex-probe-'));
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 't', account_id: 'a' } }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const usage = {
    rate_limit: { secondary_window: { used_percent: 31, limit_window_seconds: 604800, reset_at: 1791608760 } },
  };
  const answers = (...statuses: number[]) => {
    const calls: number[] = [];
    vi.stubGlobal('fetch', async () => {
      const status = statuses[calls.length] ?? 200;
      calls.push(status);
      return new Response(status === 200 ? JSON.stringify(usage) : '<html>blocked</html>', { status });
    });
    return calls;
  };

  it('asks again when Cloudflare turns a request away, as it does every so often', async () => {
    // chatgpt.com's edge answers some requests with an instant 403; the next one goes through.
    const calls = answers(403, 200);
    const probe = await fetchRateLimits({ cli: 'codex', path: dir }, dir);
    expect(probe.status?.weeklyPct).toBe(31);
    expect(calls).toEqual([403, 200]);
  });

  it('gives up after a few refusals in a row', async () => {
    // Five tries a beat apart, and the whole round once more.
    const calls = answers(...Array<number>(10).fill(403), 200);
    const probe = await fetchRateLimits({ cli: 'codex', path: dir }, dir);
    expect(probe).toEqual({ status: null, error: 'unavailable' });
    expect(calls).toHaveLength(10);
  });

  it('does not retry a stale login, nor ask claude to renew it', async () => {
    const calls = answers(401, 200);
    const renew = vi.fn(async () => {});
    expect(await fetchRateLimits({ cli: 'codex', path: dir }, dir, { renew })).toEqual({ status: null, error: 'auth' });
    expect(calls).toEqual([401]);
    expect(renew).not.toHaveBeenCalled();
  });
});

describe('parseOAuthUsage', () => {
  it('reads both windows, given in percent, with their resets', () => {
    expect(parseOAuthUsage({
      five_hour: { utilization: 9.6, resets_at: '2026-10-17T12:30:00.458583+00:00' },
      seven_day: { utilization: 19, resets_at: '2026-10-23T02:00:00+00:00' },
    })).toEqual({
      fiveHourPct: 10,
      weeklyPct: 19,
      fiveHourResetsAt: Date.parse('2026-10-17T12:30:00.458Z'),
      weeklyResetsAt: Date.parse('2026-10-23T02:00:00Z'),
    });
  });

  it('keeps a window the plan does not have as unknown, not 0%', () => {
    expect(parseOAuthUsage({ five_hour: null, seven_day: { utilization: 31 } })).toMatchObject({ fiveHourPct: null, weeklyPct: 31 });
  });

  it('returns null for an answer with neither window', () => {
    expect(parseOAuthUsage({ error: 'nope' })).toBeNull();
    expect(parseOAuthUsage(null)).toBeNull();
  });
});

describe('fetchRateLimits — claude', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aimux-claude-probe-'));
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const windows = { 'anthropic-ratelimit-unified-5h-utilization': '0.09', 'anthropic-ratelimit-unified-7d-utilization': '0.08' };
  const usage = { five_hour: { utilization: 9 }, seven_day: { utilization: 8 } };
  const profile = { cli: 'claude' as const, path: '' };

  // Answers each endpoint from its own script and records what was asked, in order.
  type Answer = (token: string, nth: number) => Response;
  const serve = (answers: { usage: Answer; messages?: Answer }) => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const token = (init.headers as Record<string, string>).authorization.replace('Bearer ', '');
      const which = url.endsWith('/api/oauth/usage') ? 'usage' : 'messages';
      const nth = asked.filter((a) => a.startsWith(which)).length;
      asked.push(`${which}:${token}`);
      const answer = answers[which] ?? (() => new Response('unexpected', { status: 500 }));
      return answer(token, nth);
    });
    return asked;
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it('reads the windows from the usage endpoint, without running a model', async () => {
    const asked = serve({ usage: () => json(usage) });

    expect((await fetchRateLimits(profile, dir)).status).toMatchObject({ fiveHourPct: 9, weeklyPct: 8 });
    expect(asked).toEqual(['usage:t']);
  });

  it('falls back to the old probe when the usage endpoint is throttled', async () => {
    const asked = serve({
      usage: () => new Response('{"type":"error"}', { status: 429 }),
      messages: () => new Response('{}', { status: 200, headers: windows }),
    });

    expect((await fetchRateLimits(profile, dir)).status).toMatchObject({ fiveHourPct: 9, weeklyPct: 8 });
    expect(asked).toEqual(['usage:t', 'messages:t']);
  });

  it('asks once more when the API was busy, instead of showing no figures for minutes', async () => {
    const asked = serve({
      usage: (_t, nth) => (nth === 0 ? new Response('overloaded', { status: 529 }) : json(usage)),
      messages: () => new Response('overloaded', { status: 529 }),
    });

    expect((await fetchRateLimits(profile, dir)).status).toMatchObject({ fiveHourPct: 9, weeklyPct: 8 });
    expect(asked).toEqual(['usage:t', 'messages:t', 'usage:t']);
  });

  it('asks once more after a dropped connection too', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      if (++calls === 1) throw new TypeError('fetch failed');
      return json(usage);
    });

    expect((await fetchRateLimits(profile, dir)).status?.weeklyPct).toBe(8);
  });

  it('has claude renew a lapsed login, then asks again', async () => {
    // The access token lives about eight hours; claude renews it, aimux only reads it.
    // A lapsed token gets 429 from the usage endpoint and 401 from the old probe.
    const asked = serve({
      usage: (token) => (token === 'fresh' ? json(usage) : new Response('{"type":"error"}', { status: 429 })),
      messages: () => new Response('unauthorized', { status: 401 }),
    });
    const renew = vi.fn(async () => {
      writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fresh' } }));
    });

    expect((await fetchRateLimits(profile, dir, { renew })).status?.weeklyPct).toBe(8);
    expect(asked).toEqual(['usage:t', 'messages:t', 'usage:fresh']);
    expect(renew).toHaveBeenCalledOnce();
  });

  it('reports a login claude could not renew, and asks claude about it only once', async () => {
    // A token of its own: the ones claude could not renew are remembered for the process.
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'gone' } }));
    const asked = serve({ usage: () => new Response('unauthorized', { status: 401 }) });
    const renew = vi.fn(async () => {});

    expect(await fetchRateLimits(profile, dir, { renew })).toEqual({ status: null, error: 'auth' });
    expect(await fetchRateLimits(profile, dir, { renew })).toEqual({ status: null, error: 'auth' });
    expect(asked).toEqual(['usage:gone', 'usage:gone']);
    expect(renew).toHaveBeenCalledOnce();
  });

  it('does not ask claude to renew a login there is no token for', async () => {
    writeFileSync(join(dir, '.credentials.json'), '{}');
    const asked = serve({ usage: () => json(usage) });
    const renew = vi.fn(async () => {});

    expect(await fetchRateLimits(profile, dir, { renew })).toEqual({ status: null, error: 'auth' });
    expect(asked).toEqual([]);
    expect(renew).not.toHaveBeenCalled();
  });

  it('falls back to the old probe when the usage endpoint refuses or answers without figures', async () => {
    for (const refusal of [new Response('forbidden', { status: 403 }), json({ five_hour: null, seven_day: null })]) {
      const asked = serve({ usage: () => refusal, messages: () => new Response('{}', { status: 200, headers: windows }) });
      expect((await fetchRateLimits(profile, dir)).status?.weeklyPct).toBe(8);
      expect(asked).toEqual(['usage:t', 'messages:t']);
    }
  });
});

describe('renewEnv', () => {
  // Never created: the profile has no .env of its own to add.
  const dir = join(tmpdir(), 'aimux-renew-env-none');
  const inherited = {
    PATH: '/usr/bin',
    CLAUDE_CONFIG_DIR: '/elsewhere/.aimux/profiles/other',
    ANTHROPIC_API_KEY: 'sk-shell',
    CLAUDE_CODE_OAUTH_TOKEN: 'oat-shell',
  };

  it("renews in the profile's own dir, with no other login riding along", () => {
    const env = renewEnv({ cli: 'claude', path: dir }, dir, inherited);
    expect(env).toMatchObject({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: dir });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('leaves the config dir unset for the source profile, as claude itself expects', () => {
    expect(renewEnv({ cli: 'claude', path: dir, is_source: true }, dir, inherited)).not.toHaveProperty('CLAUDE_CONFIG_DIR');
  });
});
