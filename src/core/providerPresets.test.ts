import { describe, it, expect } from 'vitest';
import { PROVIDER_PRESETS, providerEnv } from './apiProfile.js';

describe('PROVIDER_PRESETS', () => {
  it('covers the verified Anthropic-compatible providers with anthropic base URLs', () => {
    expect(PROVIDER_PRESETS.deepseek.baseUrl).toBe('https://api.deepseek.com/anthropic');
    expect(PROVIDER_PRESETS.kimi.baseUrl).toBe('https://api.moonshot.ai/anthropic');
    expect(PROVIDER_PRESETS.glm.baseUrl).toBe('https://api.z.ai/api/anthropic');
    expect(PROVIDER_PRESETS.qwen.baseUrl).toBe('https://dashscope-intl.aliyuncs.com/apps/anthropic');
    expect(PROVIDER_PRESETS.minimax.baseUrl).toBe('https://api.minimax.io/anthropic');
    expect(PROVIDER_PRESETS.mimo.baseUrl).toBe('https://api.xiaomimimo.com');
  });
});

describe('providerEnv', () => {
  it('maps base URL + model tiers from a preset', () => {
    const env = providerEnv(PROVIDER_PRESETS.deepseek);
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(env.ANTHROPIC_MODEL).toBe('deepseek-chat');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-reasoner');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-chat');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('includes the token when provided', () => {
    const env = providerEnv(PROVIDER_PRESETS.glm, 'sk-zai-123');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-zai-123');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4.5-air');
  });
});
