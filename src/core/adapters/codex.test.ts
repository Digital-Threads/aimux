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

describe('codex session-index DB sharing', () => {
  it('shares state_<N>.sqlite (the threads/resume index moved to SQLite in codex 0.14x)', () => {
    const a = adapterFor('codex');
    expect(a.isShared('state_5.sqlite', new Set())).toBe(true);
    expect(a.isShared('state_12.sqlite', new Set())).toBe(true);
    // not the transient sidecars (SQLite recreates them next to the source) or logs
    expect(a.isShared('state_5.sqlite-wal', new Set())).toBe(false);
    expect(a.isShared('logs_2.sqlite', new Set())).toBe(false);
    expect(a.isShared('auth.json', new Set())).toBe(false);
  });

  it('reclaims a stale real state_<N>.sqlite from the source (it is authoritative)', () => {
    const a = adapterFor('codex');
    expect(a.reclaimsFromSource?.('state_5.sqlite')).toBe(true);
    // never reclaim auth or other private real files
    expect(a.reclaimsFromSource?.('auth.json')).toBe(false);
    expect(a.reclaimsFromSource?.('logs_2.sqlite')).toBe(false);
  });

  it('claude/gemini do not reclaim conflicts (preserve the skip-on-conflict guard)', () => {
    expect(adapterFor('claude').reclaimsFromSource).toBeUndefined();
    expect(adapterFor('gemini').reclaimsFromSource).toBeUndefined();
  });
});

describe('resumeArgs', () => {
  it('codex resumes via "resume <id>" (overlay added by globalArgs; no fork flag)', () => {
    // resumeArgs no longer hardcodes -p; the single injection point is globalArgs(),
    // which resumeSession prepends. globalArgs('resume') === ['-p','aimux'].
    expect(adapterFor('codex').resumeArgs('uuid-1')).toEqual(['resume', 'uuid-1']);
    expect(adapterFor('codex').resumeArgs('uuid-1', { fork: true })).toEqual(['resume', 'uuid-1']);
    expect(adapterFor('codex').globalArgs('resume')).toEqual(['-p', 'aimux']);
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

  it('codex writes the final message to outFile via exec --output-last-message (overlay added by buildRunParams)', () => {
    const a = adapterFor('codex');
    expect(a.headlessCaptureToFile).toBe(true);
    // No -p here: headlessArgs flows through buildRunParams, whose globalArgs('exec')
    // injects `-p aimux`. Including it here would double it.
    expect(a.headlessArgs('hi', '/tmp/out.txt')).toEqual(['exec', '--output-last-message', '/tmp/out.txt', 'hi']);
    expect(a.headlessArgs('hi')).toEqual(['exec', 'hi']);
  });

  it('globalArgs injects the overlay for exec so the headless summarizer carries it once', () => {
    expect(adapterFor('codex').globalArgs('exec')).toEqual(['-p', 'aimux']);
  });
});

describe('codex overlay (globalArgs + extraLinks)', () => {
  it('injects -p aimux for runtime invocations (interactive, exec, resume) but not management', () => {
    const a = adapterFor('codex');
    expect(a.globalArgs(undefined)).toEqual(['-p', 'aimux']); // interactive
    expect(a.globalArgs('--model')).toEqual(['-p', 'aimux']); // leading flag
    expect(a.globalArgs('resume')).toEqual(['-p', 'aimux']);
    expect(a.globalArgs('exec')).toEqual(['-p', 'aimux']);
    expect(a.globalArgs('plugin')).toEqual([]); // management subcommand rejects -p
    expect(a.globalArgs('doctor')).toEqual([]);
    expect(a.globalArgs('login')).toEqual([]);
  });

  it('claude injects no global args', () => {
    expect(adapterFor('claude').globalArgs(undefined)).toEqual([]);
    expect(adapterFor('claude').globalArgs('mcp')).toEqual([]);
  });

  it('codex extra links: overlay config + plugins from the source', () => {
    const links = adapterFor('codex').extraLinks('/home/u/.codex');
    expect(links).toEqual([
      { link: 'aimux.config.toml', target: '/home/u/.codex/config.toml' },
      { link: 'plugins', target: '/home/u/.codex/plugins' },
    ]);
  });

  it('claude has no extra links', () => {
    expect(adapterFor('claude').extraLinks('/home/u/.claude')).toEqual([]);
  });
});
