import { describe, it, expect } from 'vitest';
import { adapterFor } from './index.js';

describe('codexAdapter run-path', () => {
  it('is selected for cli "codex"', () => {
    expect(adapterFor('codex').id).toBe('codex');
  });

  it('emits -m <model> when set and not a subcommand', () => {
    const a = adapterFor('codex');
    expect(
      a.modelArgs({ model: 'gpt-5-codex', isSubcommand: false, userPassedModel: false, userPassedFallback: false }),
    ).toEqual(['-m', 'gpt-5-codex']);
  });

  it('omits the model flag for a subcommand (e.g. exec)', () => {
    const a = adapterFor('codex');
    expect(
      a.modelArgs({ model: 'gpt-5-codex', isSubcommand: true, userPassedModel: false, userPassedFallback: false }),
    ).toEqual([]);
  });

  it('omits the model flag when the user already passed one', () => {
    const a = adapterFor('codex');
    expect(
      a.modelArgs({ model: 'gpt-5-codex', isSubcommand: false, userPassedModel: true, userPassedFallback: false }),
    ).toEqual([]);
  });

  it('ignores fallbackModel (codex has no --fallback-model)', () => {
    const a = adapterFor('codex');
    expect(
      a.modelArgs({ model: 'm', fallbackModel: 'other', isSubcommand: false, userPassedModel: false, userPassedFallback: false }),
    ).toEqual(['-m', 'm']);
  });

  it('isolates via CODEX_HOME for a non-source profile', () => {
    const a = adapterFor('codex');
    expect(a.configDirEnv('/home/u/.aimux/profiles/codework', false)).toEqual({
      CODEX_HOME: '/home/u/.aimux/profiles/codework',
    });
  });

  it('sets no config-dir env for a source profile', () => {
    const a = adapterFor('codex');
    expect(a.configDirEnv('/home/u/.codex', true)).toEqual({});
  });
});

describe('codexAdapter auth/source metadata', () => {
  it('logs in via "codex login" and proves auth via auth.json', () => {
    const a = adapterFor('codex');
    expect(a.authArgs()).toEqual(['login']);
    expect(a.credentialsFile()).toBe('auth.json');
  });

  it('defaults its source-of-truth to ~/.codex', () => {
    expect(adapterFor('codex').defaultSource()).toBe('~/.codex');
  });

  it('claude keeps its auth/source metadata', () => {
    const c = adapterFor('claude');
    expect(c.authArgs()).toEqual(['auth', 'login']);
    expect(c.credentialsFile()).toBe('.credentials.json');
    expect(c.defaultSource()).toBe('~/.claude');
  });
});

describe('resumeArgs', () => {
  it('codex resumes via "resume <id>" (no fork flag)', () => {
    expect(adapterFor('codex').resumeArgs('uuid-1')).toEqual(['resume', 'uuid-1']);
    expect(adapterFor('codex').resumeArgs('uuid-1', { fork: true })).toEqual(['resume', 'uuid-1']);
  });

  it('claude resumes via "--resume <id>" and adds --fork-session for a live session', () => {
    expect(adapterFor('claude').resumeArgs('id-1')).toEqual(['--resume', 'id-1']);
    expect(adapterFor('claude').resumeArgs('id-1', { fork: true })).toEqual(['--resume', 'id-1', '--fork-session']);
  });
});

describe('headlessArgs (summarizer capture)', () => {
  it('claude prints to stdout via -p', () => {
    const c = adapterFor('claude');
    expect(c.headlessArgs('hi')).toEqual(['-p', 'hi']);
    expect(c.headlessCaptureToFile).toBe(false);
  });

  it('codex writes the final message to outFile via exec --output-last-message', () => {
    const a = adapterFor('codex');
    expect(a.headlessCaptureToFile).toBe(true);
    expect(a.headlessArgs('hi', '/tmp/out.txt')).toEqual(['exec', '--output-last-message', '/tmp/out.txt', 'hi']);
    expect(a.headlessArgs('hi')).toEqual(['exec', 'hi']);
  });
});
