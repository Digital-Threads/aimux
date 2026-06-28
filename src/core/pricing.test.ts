import { describe, it, expect } from 'vitest';
import { estimateCost, hasPricing, resolvePricing } from './pricing.js';
import type { UsageTotals } from './usage.js';

function totals(partial: Partial<UsageTotals>): UsageTotals {
  return {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    ...partial,
  };
}

describe('resolvePricing', () => {
  it('matches an exact known model id', () => {
    expect(resolvePricing('claude-opus-4-7')?.input).toBeGreaterThan(0);
  });

  it('matches a Claude family by prefix when the exact id is unseen', () => {
    // A future patch version we never hardcoded still resolves to the family.
    expect(resolvePricing('claude-sonnet-4-9-20991231')).toEqual(
      resolvePricing('claude-sonnet-4-6'),
    );
  });

  it('returns null for an unknown model', () => {
    expect(resolvePricing('totally-made-up-model')).toBeNull();
  });

  it('prices codex / gpt-5 models so codex usage is not silently $0', () => {
    expect(resolvePricing('gpt-5-codex')?.input).toBeGreaterThan(0);
    expect(resolvePricing('gpt-5.3-codex')?.input).toBeGreaterThan(0);
    expect(resolvePricing('gpt-5')?.input).toBeGreaterThan(0);
  });

  it('matches a future gpt-5.x codex variant by prefix', () => {
    // An unseen codex point-release still resolves (to the gpt-5 family) rather than null.
    expect(resolvePricing('gpt-5.9-codex-20991231')).not.toBeNull();
  });
});

describe('hasPricing', () => {
  it('is true for a known model and false for an unknown one', () => {
    expect(hasPricing('claude-opus-4-7')).toBe(true);
    expect(hasPricing('totally-made-up-model')).toBe(false);
  });
});

describe('estimateCost', () => {
  it('computes cost from per-1M prices across all token buckets', () => {
    const p = resolvePricing('claude-sonnet-4-6')!;
    const t = totals({
      inputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    const expected = p.input + p.cacheWrite + p.cacheRead + p.output;
    expect(estimateCost(t, 'claude-sonnet-4-6')).toBeCloseTo(expected, 6);
  });

  it('scales linearly with token count', () => {
    const half = estimateCost(totals({ outputTokens: 500_000 }), 'claude-opus-4-7');
    const full = estimateCost(totals({ outputTokens: 1_000_000 }), 'claude-opus-4-7');
    expect(full).toBeCloseTo(half * 2, 6);
  });

  it('returns 0 for an unknown model', () => {
    expect(estimateCost(totals({ outputTokens: 1_000_000 }), 'totally-made-up-model')).toBe(0);
  });
});
