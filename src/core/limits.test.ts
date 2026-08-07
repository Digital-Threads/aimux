import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProfileConfig } from '../types/index.js';
import { parseRateLimitHeaders, pctColor, rateLimitProfiles } from './limits.js';

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

  it('defaults a missing window to 0% when the other window is present', () => {
    const onlyFive = { 'anthropic-ratelimit-unified-5h-utilization': '0.3' };
    const r = parseRateLimitHeaders(onlyFive)!;
    expect(r.fiveHourPct).toBe(30);
    expect(r.weeklyPct).toBe(0);
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

  it('skips non-claude profiles — the probe hits the Anthropic API, so a codex or gemini profile would only waste a request', () => {
    expect(rateLimitProfiles({ cx: profile({ cli: 'codex' }), gm: profile({ cli: 'gemini' }) })).toEqual([]);
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
