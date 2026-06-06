import { describe, it, expect } from 'vitest';
import { parseRateLimitHeaders } from './limits.js';

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
