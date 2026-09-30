import { describe, it, expect } from 'vitest';
import { estimateCost, hasPricing, resolvePricing, type ModelPricing } from './pricing.js';
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

describe('official list prices', () => {
  // Checked 2026-09-30 against docs.claude.com pricing, developers.openai.com pricing
  // and api-docs.deepseek.com pricing. One case per model, not per family: the
  // families no longer share a price — Opus 4.5+ costs a third of Opus 4.1, and
  // Opus 5.5 reads its cache at 0.05× input, not the old 0.1× convention.
  const opus45to5 = { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 };
  const opusLegacy = { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 };
  const sonnet5 = { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 };
  const deepseekFlash = { input: 0.15, cacheWrite: 0.15, cacheRead: 0.003, output: 0.6 };

  const cases: Array<[string, ModelPricing]> = [
    ['claude-opus-5-5', { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 }],
    ['claude-opus-5', opus45to5],
    ['claude-opus-4-8', opus45to5],
    ['claude-opus-4-6', opus45to5],
    ['claude-opus-4-5-20251101', opus45to5],
    ['claude-opus-4-1-20250805', opusLegacy],
    ['claude-opus-4-20250514', opusLegacy],
    ['claude-sonnet-5-5', sonnet5],
    ['claude-sonnet-5', sonnet5],
    ['claude-sonnet-4-6', { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 }],
    ['claude-fable-5-1', { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 }],
    ['claude-haiku-4-5', { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }],
    ['gpt-6.1-sol', { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 }],
    ['gpt-6-sol', { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 }],
    ['gpt-6-luna', { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 }],
    ['gpt-6-astra', { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 }],
    ['gpt-5.6-sol', { input: 4, cacheWrite: 5, cacheRead: 0.4, output: 20 }],
    ['deepseek-flash', deepseekFlash],
    // Retired name: DeepSeek still accepts it, serves it with Flash and bills Flash.
    ['deepseek-v4-flash', deepseekFlash],
    ['deepseek-v4-pro', { input: 0.66, cacheWrite: 0.66, cacheRead: 0.022, output: 1.98 }],
  ];

  for (const [model, price] of cases) {
    it(`prices ${model} at its list price`, () => {
      expect(resolvePricing(model)).toEqual(price);
    });
  }

  it('prices a [1m] model id like its base id', () => {
    expect(resolvePricing('claude-opus-5-5[1m]')).toEqual(resolvePricing('claude-opus-5-5'));
  });
});
