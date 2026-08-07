import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProfileConfig } from '../types/index.js';
import { parseRateLimitHeaders, parseCodexUsage, pctColor, probeError, rateLimitProfiles, formatResetAt } from './limits.js';

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
