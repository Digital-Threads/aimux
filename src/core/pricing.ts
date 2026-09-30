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

/** Anthropic list price at the 5-minute cache-write tier (1.25× input; the 1-hour
 *  tier is 2× and transcripts do not always say which one was written). Cache reads
 *  are passed in per model — the old 0.1× input convention stopped holding at
 *  Opus 5.5, which reads at 0.05×. */
function claudeTier(input: number, output: number, cacheRead: number): ModelPricing {
  return { input, cacheWrite: input * 1.25, cacheRead, output };
}

/** OpenAI publishes all four figures; the short-context (<272K) row is used. */
function openaiTier(input: number, cachedInput: number, cacheWrite: number, output: number): ModelPricing {
  return { input, cacheWrite, cacheRead: cachedInput, output };
}

function thirdParty(input: number, output: number): ModelPricing {
  // Most OpenAI-compatible endpoints bill cache reads at ~0.1× input and do not
  // surcharge cache writes; approximate accordingly.
  return { input, cacheWrite: input, cacheRead: input * 0.1, output };
}

// List prices checked 2026-09-30 against docs.claude.com, developers.openai.com and
// api-docs.deepseek.com. Families no longer share one price, so each is its own row.
const OPUS_5_5 = claudeTier(4, 20, 0.2);
const OPUS_4_5_TO_5 = claudeTier(5, 25, 0.5);
const OPUS_4_AND_4_1 = claudeTier(15, 75, 1.5);
const SONNET_5 = claudeTier(2, 10, 0.2);
const SONNET_4 = claudeTier(3, 15, 0.3);
const FABLE_5_1 = claudeTier(10, 50, 0.25);
const FABLE_5 = claudeTier(10, 50, 1);
const HAIKU_4_5 = claudeTier(1, 5, 0.1);

const GPT_6_1_SOL = openaiTier(2, 0.1, 2.5, 10);

// DeepSeek bills a cache miss as plain input (no write surcharge) and reads its cache
// at a fiftieth of that. Off-peak rates: peak doubles them, but only Mon–Fri
// 01:00–04:00 and 06:00–10:00 UTC — about a fifth of the week.
// ponytail: flat off-peak price; bill each request by its timestamp if DeepSeek use grows.
const DEEPSEEK_FLASH: ModelPricing = { input: 0.15, cacheWrite: 0.15, cacheRead: 0.003, output: 0.6 };
const DEEPSEEK_PRO: ModelPricing = { input: 0.66, cacheWrite: 0.66, cacheRead: 0.022, output: 1.98 };

/** Exact-id price table. Unseen ids resolve via family prefixes below. */
export const MODEL_PRICING: Record<string, ModelPricing> = {
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

/** Family prefixes, checked in order — a longer prefix must come before any shorter
 *  one it extends. Also catches date-suffixed and `[1m]` ids. */
const FAMILY_PREFIXES: Array<[string, ModelPricing]> = [
  ['claude-opus-5-5', OPUS_5_5],
  ['claude-opus-5', OPUS_4_5_TO_5],
  ['claude-opus-4-8', OPUS_4_5_TO_5],
  ['claude-opus-4-7', OPUS_4_5_TO_5],
  ['claude-opus-4-6', OPUS_4_5_TO_5],
  ['claude-opus-4-5', OPUS_4_5_TO_5],
  ['claude-opus-4', OPUS_4_AND_4_1],
  ['claude-opus', OPUS_5_5], // an unreleased Opus: price it like the newest
  ['claude-sonnet-5', SONNET_5],
  ['claude-sonnet-4', SONNET_4],
  ['claude-sonnet', SONNET_5],
  ['claude-fable-5-1', FABLE_5_1],
  ['claude-fable-5', FABLE_5],
  ['claude-fable', FABLE_5_1],
  ['claude-haiku', HAIKU_4_5],
  ['glm-4', thirdParty(0.6, 2.2)],
  ['kimi', thirdParty(0.6, 2.5)],
  ['deepseek-v4-pro', DEEPSEEK_PRO],
  // Retired name: still accepted, served by and billed as Flash.
  ['deepseek-v4-flash', DEEPSEEK_FLASH],
  ['deepseek-flash', DEEPSEEK_FLASH],
  ['deepseek-reasoner', thirdParty(0.55, 2.19)],
  ['deepseek', thirdParty(0.27, 1.1)],
  ['qwen', thirdParty(1.6, 6.4)],
  ['gpt-6.1-sol', GPT_6_1_SOL],
  ['gpt-6-astra', openaiTier(10, 1, 12.5, 50)],
  ['gpt-6-sol', openaiTier(2, 0.2, 2.5, 10)],
  ['gpt-6-luna', openaiTier(0.1, 0.01, 0.125, 0.5)],
  ['gpt-6', GPT_6_1_SOL], // an unreleased gpt-6.x: price it like codex's current default
  ['gpt-5.6-sol', openaiTier(4, 0.4, 5, 20)],
  ['gpt-5.6-terra', openaiTier(2, 0.2, 2.5, 12)],
  ['gpt-5.6-luna', openaiTier(0.2, 0.02, 0.25, 1.2)],
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
