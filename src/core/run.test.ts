import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRunParams, runProfileHeadless, looksLikeSubcommand, parseDotenv, loadProfileEnv } from './run.js';
import type { AimuxConfig, ProfileConfig } from '../types/index.js';

function makeConfig(ownExtras?: Partial<ProfileConfig>): AimuxConfig {
  return {
    version: 1,
    shared_source: '/home/user/.claude',
    profiles: {
      main: { cli: 'claude', path: '/home/user/.claude', is_source: true },
      work: { cli: 'claude', path: '/home/user/.aimux/profiles/work', model: 'claude-opus-4-6' },
      own: { cli: 'claude', path: '/home/user/.aimux/profiles/own', ...ownExtras },
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

  it('passes profile fallback_model as --fallback-model', () => {
    const params = buildRunParams(makeConfig({ fallback_model: 'claude-haiku-4-5' }), 'own');
    expect(params.args).toContain('--fallback-model');
    expect(params.args).toContain('claude-haiku-4-5');
  });

  it('omits --fallback-model when not set', () => {
    const params = buildRunParams(makeConfig(), 'work');
    expect(params.args).not.toContain('--fallback-model');
  });

  it('skips --fallback-model when first extra arg is a subcommand', () => {
    const params = buildRunParams(makeConfig({ fallback_model: 'claude-haiku-4-5' }), 'own', {
      extraArgs: ['agents'],
    });
    expect(params.args).not.toContain('--fallback-model');
  });

  it('does not add --fallback-model when user passed one in extra args', () => {
    const params = buildRunParams(makeConfig({ fallback_model: 'claude-haiku-4-5' }), 'own', {
      extraArgs: ['--fallback-model', 'claude-sonnet-4-6'],
    });
    expect(params.args.filter((a) => a === '--fallback-model')).toHaveLength(1);
    expect(params.args).not.toContain('claude-haiku-4-5');
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

  it('forwards profile env block to the spawned process', () => {
    const config = makeConfig({ env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' } });
    const params = buildRunParams(config, 'own');
    expect(params.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(params.env.AWS_REGION).toBe('us-east-1');
  });
});

describe('parseDotenv', () => {
  it('parses basic KEY=VALUE pairs', () => {
    expect(parseDotenv('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('skips comments and blank lines', () => {
    expect(parseDotenv('# a comment\n\nFOO=bar\n')).toEqual({ FOO: 'bar' });
  });

  it('supports the `export` prefix', () => {
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

  it('strips inline comments AFTER a quoted value (PR #3 reviewer bug)', () => {
    expect(parseDotenv('FOO="bar" # comment')).toEqual({ FOO: 'bar' });
    expect(parseDotenv("BAR='qux'  # trailing")).toEqual({ BAR: 'qux' });
  });

  it('keeps a value that has an unterminated quote literal', () => {
    expect(parseDotenv('FOO="bar')).toEqual({ FOO: '"bar' });
  });

  it('treats tab-before-hash as an inline comment', () => {
    expect(parseDotenv('FOO=bar\t# comment')).toEqual({ FOO: 'bar' });
  });

  it('decodes \\r escapes inside double quotes', () => {
    expect(parseDotenv('FOO="a\\rb"')).toEqual({ FOO: 'a\rb' });
  });
});

describe('loadProfileEnv', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aimux-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads .env from the profile directory', () => {
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_AUTH_TOKEN=secret123\n');
    const env = loadProfileEnv({ cli: 'claude', path: dir }, dir);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('secret123');
  });

  it('lets the YAML env block override .env on key conflict', () => {
    writeFileSync(join(dir, '.env'), 'ANTHROPIC_MODEL=from-dotenv\n');
    const env = loadProfileEnv({ cli: 'claude', path: dir, env: { ANTHROPIC_MODEL: 'from-yaml' } }, dir);
    expect(env.ANTHROPIC_MODEL).toBe('from-yaml');
  });

  it('returns an empty object when neither .env nor env block exist', () => {
    expect(loadProfileEnv({ cli: 'claude', path: dir }, dir)).toEqual({});
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

describe('runProfileHeadless', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aimux-headless-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function stubConfig(): AimuxConfig {
    return {
      version: 1,
      shared_source: dir,
      profiles: { stub: { cli: 'node', path: dir } },
      private: [],
    };
  }

  it('captures stdout + exit code and injects task/workflow ids into env', async () => {
    const script =
      'process.stdout.write("OUT:" + process.env.LOOM_TASK_ID + ":" + process.env.LOOM_WORKFLOW_ID); process.exit(3);';
    const res = await runProfileHeadless(stubConfig(), 'stub', {
      extraArgs: ['-e', script],
      taskId: 'tj-1',
      workflowId: 'wf-1',
    });
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe('OUT:tj-1:wf-1');
  });

  it('captures stderr and leaves ids unset when not provided', async () => {
    const script = 'process.stderr.write("ERR:" + String(process.env.LOOM_TASK_ID));';
    const res = await runProfileHeadless(stubConfig(), 'stub', { extraArgs: ['-e', script] });
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe('ERR:undefined');
    expect(res.stdout).toBe('');
  });
});
