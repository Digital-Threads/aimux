import { describe, it, expect } from 'vitest';
import { buildRunParams } from './run.js';
import type { AimuxConfig } from '../types/index.js';

function makeConfig(): AimuxConfig {
  return {
    version: 1,
    shared_source: '/home/user/.claude',
    profiles: {
      main: { cli: 'claude', path: '/home/user/.claude', is_source: true },
      work: { cli: 'claude', path: '/home/user/.aimux/profiles/work', model: 'claude-opus-4-6' },
      own: { cli: 'claude', path: '/home/user/.aimux/profiles/own' },
    },
    private: ['.credentials.json'],
  };
}

describe('buildRunParams', () => {
  it('sets CLAUDE_CONFIG_DIR for non-source profile', () => {
    const params = buildRunParams(makeConfig(), 'work');
    expect(params.env.CLAUDE_CONFIG_DIR).toBe('/home/user/.aimux/profiles/work');
    expect(params.cli).toBe('claude');
  });

  it('does not set CLAUDE_CONFIG_DIR for source profile', () => {
    const params = buildRunParams(makeConfig(), 'main');
    expect(params.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('uses profile default model', () => {
    const params = buildRunParams(makeConfig(), 'work');
    expect(params.args).toContain('--model');
    expect(params.args).toContain('claude-opus-4-6');
  });

  it('overrides model with option', () => {
    const params = buildRunParams(makeConfig(), 'work', { model: 'claude-sonnet-4-6' });
    expect(params.args).toContain('claude-sonnet-4-6');
    expect(params.args).not.toContain('claude-opus-4-6');
  });

  it('omits --model when no model set', () => {
    const params = buildRunParams(makeConfig(), 'own');
    expect(params.args).not.toContain('--model');
  });

  it('passes extra args', () => {
    const params = buildRunParams(makeConfig(), 'work', { extraArgs: ['--verbose'] });
    expect(params.args).toContain('--verbose');
  });

  it('throws for unknown profile', () => {
    expect(() => buildRunParams(makeConfig(), 'unknown')).toThrow('not found');
  });
});
