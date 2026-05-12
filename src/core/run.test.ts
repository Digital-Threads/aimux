import { describe, it, expect } from 'vitest';
import { buildRunParams, looksLikeSubcommand } from './run.js';
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

  it('skips --model when first extra arg is a subcommand', () => {
    const params = buildRunParams(makeConfig(), 'work', { extraArgs: ['agents'] });
    expect(params.args).not.toContain('--model');
    expect(params.args).toEqual(['agents']);
  });

  it('skips --model for kebab-case subcommand', () => {
    const params = buildRunParams(makeConfig(), 'work', { extraArgs: ['setup-token'] });
    expect(params.args).not.toContain('--model');
    expect(params.args).toEqual(['setup-token']);
  });

  it('keeps --model when first extra arg is a flag', () => {
    const params = buildRunParams(makeConfig(), 'work', { extraArgs: ['-p', 'hello'] });
    expect(params.args).toContain('--model');
    expect(params.args).toContain('claude-opus-4-6');
  });

  it('keeps --model when first extra arg is a prompt with spaces', () => {
    const params = buildRunParams(makeConfig(), 'work', { extraArgs: ['write a test'] });
    expect(params.args).toContain('--model');
  });

  it('does not duplicate --model when user passes it via extraArgs', () => {
    const params = buildRunParams(makeConfig(), 'work', { extraArgs: ['--model', 'sonnet'] });
    const modelFlags = params.args.filter((a) => a === '--model');
    expect(modelFlags.length).toBe(1);
    expect(params.args).toContain('sonnet');
    expect(params.args).not.toContain('claude-opus-4-6');
  });
});

describe('looksLikeSubcommand', () => {
  it('detects simple subcommand', () => {
    expect(looksLikeSubcommand('agents')).toBe(true);
    expect(looksLikeSubcommand('mcp')).toBe(true);
    expect(looksLikeSubcommand('doctor')).toBe(true);
  });

  it('detects kebab-case subcommand', () => {
    expect(looksLikeSubcommand('setup-token')).toBe(true);
    expect(looksLikeSubcommand('auto-mode')).toBe(true);
  });

  it('rejects flags', () => {
    expect(looksLikeSubcommand('--model')).toBe(false);
    expect(looksLikeSubcommand('-p')).toBe(false);
  });

  it('rejects prompts with spaces or punctuation', () => {
    expect(looksLikeSubcommand('hello world')).toBe(false);
    expect(looksLikeSubcommand('what?')).toBe(false);
    expect(looksLikeSubcommand('Run tests')).toBe(false);
  });

  it('rejects undefined/empty', () => {
    expect(looksLikeSubcommand(undefined)).toBe(false);
    expect(looksLikeSubcommand('')).toBe(false);
  });
});
