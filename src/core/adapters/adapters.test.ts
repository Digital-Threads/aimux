import { describe, it, expect } from 'vitest';
import { adapterFor } from './index.js';

describe('adapterFor', () => {
  it('returns the claude adapter for cli "claude"', () => {
    expect(adapterFor('claude').id).toBe('claude');
  });

  it('falls back to the claude adapter for unknown/custom cli (backward compat)', () => {
    expect(adapterFor('/custom/claude-wrapper').id).toBe('claude');
    expect(adapterFor('anything').id).toBe('claude');
  });
});

describe('claudeAdapter run-path', () => {
  it('emits --model when a model is set and not a subcommand', () => {
    const a = adapterFor('claude');
    expect(
      a.modelArgs({ model: 'claude-opus-4-6', isSubcommand: false, userPassedModel: false, userPassedFallback: false }),
    ).toEqual(['--model', 'claude-opus-4-6']);
  });

  it('omits --model when the user already passed one', () => {
    const a = adapterFor('claude');
    expect(
      a.modelArgs({ model: 'claude-opus-4-6', isSubcommand: false, userPassedModel: true, userPassedFallback: false }),
    ).toEqual([]);
  });

  it('omits --model for a subcommand invocation', () => {
    const a = adapterFor('claude');
    expect(
      a.modelArgs({ model: 'claude-opus-4-6', isSubcommand: true, userPassedModel: false, userPassedFallback: false }),
    ).toEqual([]);
  });

  it('appends --fallback-model when set and not already passed', () => {
    const a = adapterFor('claude');
    expect(
      a.modelArgs({ model: 'm', fallbackModel: 'claude-sonnet-4-6', isSubcommand: false, userPassedModel: false, userPassedFallback: false }),
    ).toEqual(['--model', 'm', '--fallback-model', 'claude-sonnet-4-6']);
  });

  it('sets CLAUDE_CONFIG_DIR for a non-source profile', () => {
    const a = adapterFor('claude');
    expect(a.configDirEnv('/home/u/.aimux/profiles/work', false)).toEqual({
      CLAUDE_CONFIG_DIR: '/home/u/.aimux/profiles/work',
    });
  });

  it('sets no config-dir env for the source profile', () => {
    const a = adapterFor('claude');
    expect(a.configDirEnv('/home/u/.claude', true)).toEqual({});
  });
});
