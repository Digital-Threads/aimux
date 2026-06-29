import type { UsageTotals } from './usage.js';

/**
 * Per-1M-token USD prices. Transcripts carry no `cost_usd`, so $ figures are
 * derived as `tokens × price`. Values are public list prices at time of writing
 * and WILL drift — treat the resulting $ as an estimate, not a bill.
 *
 * Buckets mirror UsageTotals: plain input, cache-write (cache_creation),
 * cache-read, and output. For models without published cache tiers we fall back
 * to the Anthropic convention (write = 1.25× input, read = 0.1× input).
 */
export interface ModelPricing {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

function claudeTier(input: number, output: number): ModelPricing {
  return { input, cacheWrite: input * 1.25, cacheRead: input * 0.1, output };
}

function thirdParty(input: number, output: number): ModelPricing {
  // Most OpenAI-compatible endpoints bill cache reads at ~0.1× input and do not
  // surcharge cache writes; approximate accordingly.
  return { input, cacheWrite: input, cacheRead: input * 0.1, output };
}

/** Exact-id price table. Unseen ids resolve via family prefixes below. */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6': claudeTier(15, 75),
  'claude-opus-4-7': claudeTier(15, 75),
  'claude-opus-4-8': claudeTier(15, 75),
  'claude-sonnet-4-6': claudeTier(3, 15),
  'claude-haiku-4-5': claudeTier(1, 5),
  'glm-4.6': thirdParty(0.6, 2.2),
  'kimi-k2': thirdParty(0.6, 2.5),
  'deepseek-chat': thirdParty(0.27, 1.1),
  'deepseek-reasoner': thirdParty(0.55, 2.19),
  'qwen-max': thirdParty(1.6, 6.4),
  // OpenAI / codex CLI (list prices, same cache shape as other OpenAI-compatible
  // endpoints). Subscription codex isn't billed per token; this estimates what the
  // same tokens would cost at API list price, mirroring how Claude profiles are costed.
  'gpt-5.3-codex': thirdParty(1.75, 14),
  'gpt-5-codex': thirdParty(1.25, 10),
  'gpt-5.5': thirdParty(5, 30),
  'gpt-5.4': thirdParty(2.5, 15),
  'gpt-5': thirdParty(1.25, 10),
};

/** Family fallbacks, longest-prefix-first, for unseen patch/date variants. */
const FAMILY_PREFIXES: Array<[string, ModelPricing]> = [
  ['claude-opus', claudeTier(15, 75)],
  ['claude-sonnet', claudeTier(3, 15)],
  ['claude-haiku', claudeTier(1, 5)],
  ['glm-4', thirdParty(0.6, 2.2)],
  ['kimi', thirdParty(0.6, 2.5)],
  ['deepseek-reasoner', thirdParty(0.55, 2.19)],
  ['deepseek', thirdParty(0.27, 1.1)],
  ['qwen', thirdParty(1.6, 6.4)],
  // Longest-first so a codex point-release wins over the bare gpt-5 family.
  ['gpt-5.3-codex', thirdParty(1.75, 14)],
  ['gpt-5-codex', thirdParty(1.25, 10)],
  ['gpt-5.5', thirdParty(5, 30)],
  ['gpt-5.4', thirdParty(2.5, 15)],
  ['gpt-5', thirdParty(1.25, 10)],
];

export function resolvePricing(model: string): ModelPricing | null {
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  for (const [prefix, pricing] of FAMILY_PREFIXES) {
    if (model.startsWith(prefix)) return pricing;
  }
  return null;
}

export function hasPricing(model: string): boolean {
  return resolvePricing(model) !== null;
}

/** Estimate USD for one model's token totals. Returns 0 for unknown models. */
export function estimateCost(totals: UsageTotals, model: string): number {
  const p = resolvePricing(model);
  if (!p) return 0;
  return (
    (totals.inputTokens * p.input +
      totals.cacheCreationInputTokens * p.cacheWrite +
      totals.cacheReadInputTokens * p.cacheRead +
      totals.outputTokens * p.output) /
    1_000_000
  );
}
