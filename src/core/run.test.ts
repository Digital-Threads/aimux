import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRunParams, parseDotenv, loadProfileEnv } from './run.js';
import type { AimuxConfig } from '../types/index.js';

function makeConfig(extras?: Partial<AimuxConfig['profiles']['']>): AimuxConfig {
  return {
    version: 1,
    shared_source: '/home/user/.claude',
    profiles: {
      main: { cli: 'claude', path: '/home/user/.claude', is_source: true },
      work: { cli: 'claude', path: '/home/user/.aimux/profiles/work', model: 'claude-opus-4-6' },
      own: { cli: 'claude', path: '/home/user/.aimux/profiles/own', ...extras },
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

  it('forwards profile env block to spawned process', () => {
    const config = makeConfig({ env: { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_RESOURCE: 'my-resource' } });
    const params = buildRunParams(config, 'own');
    expect(params.env.CLAUDE_CODE_USE_FOUNDRY).toBe('1');
    expect(params.env.ANTHROPIC_FOUNDRY_RESOURCE).toBe('my-resource');
  });
});

describe('parseDotenv', () => {
  it('parses basic KEY=VALUE pairs', () => {
    expect(parseDotenv('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('skips comments and blank lines', () => {
    expect(parseDotenv('# a comment\n\nFOO=bar\n')).toEqual({ FOO: 'bar' });
  });

  it('supports `export` prefix', () => {
    expect(parseDotenv('export FOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('strips matching surrounding quotes', () => {
    expect(parseDotenv('FOO="bar baz"\nBAR=\'qux\'')).toEqual({ FOO: 'bar baz', BAR: 'qux' });
  });

  it('decodes escapes inside double quotes only', () => {
    expect(parseDotenv('FOO="line1\\nline2"\nBAR=\'line1\\nline2\'')).toEqual({
      FOO: 'line1\nline2',
      BAR: 'line1\\nline2',
    });
  });

  it('strips inline comments on unquoted values', () => {
    expect(parseDotenv('FOO=bar # trailing\n')).toEqual({ FOO: 'bar' });
  });

  it('preserves `#` inside quoted values', () => {
    expect(parseDotenv('FOO="bar # not a comment"')).toEqual({ FOO: 'bar # not a comment' });
  });
});

describe('loadProfileEnv', () => {
  const TEST_DIR = join(tmpdir(), `aimux-env-test-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('reads .env from profile dir', () => {
    writeFileSync(join(TEST_DIR, '.env'), 'ANTHROPIC_FOUNDRY_API_KEY=secret123\n');
    const env = loadProfileEnv({ cli: 'claude', path: TEST_DIR }, TEST_DIR);
    expect(env.ANTHROPIC_FOUNDRY_API_KEY).toBe('secret123');
  });

  it('YAML env overrides .env on key conflict', () => {
    writeFileSync(join(TEST_DIR, '.env'), 'CLAUDE_CODE_USE_FOUNDRY=0\n');
    const env = loadProfileEnv(
      { cli: 'claude', path: TEST_DIR, env: { CLAUDE_CODE_USE_FOUNDRY: '1' } },
      TEST_DIR,
    );
    expect(env.CLAUDE_CODE_USE_FOUNDRY).toBe('1');
  });

  it('returns empty object when no .env and no env block', () => {
    const env = loadProfileEnv({ cli: 'claude', path: TEST_DIR }, TEST_DIR);
    expect(env).toEqual({});
  });
});
