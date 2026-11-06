import { describe, it, expect } from 'vitest';
import { adapterFor } from './index.js';
import { expandHome, userHome } from '../paths.js';

const HOME_VAR = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';

describe('agyAdapter run-path', () => {
  it('is selected for cli "agy"', () => {
    expect(adapterFor('agy').id).toBe('agy');
  });

  it('emits --model <model> when set and not a subcommand', () => {
    const a = adapterFor('agy');
    expect(a.modelArgs({ model: 'gemini-4-argon-high', isSubcommand: false, userPassedModel: false, userPassedFallback: false }))
      .toEqual(['--model', 'gemini-4-argon-high']);
  });

  it('omits the model flag for a subcommand or a user-passed model', () => {
    const a = adapterFor('agy');
    expect(a.modelArgs({ model: 'm', isSubcommand: true, userPassedModel: false, userPassedFallback: false })).toEqual([]);
    expect(a.modelArgs({ model: 'm', isSubcommand: false, userPassedModel: true, userPassedFallback: false })).toEqual([]);
  });

  it('places the profile config where agy looks under a home: .gemini/antigravity-cli', () => {
    const a = adapterFor('agy');
    expect(a.configPathFor!('~/.aimux/profiles/a')).toBe('~/.aimux/profiles/a/.gemini/antigravity-cli');
    expect(a.homeDir).toBe('.gemini/antigravity-cli');
  });

  it('isolates by pointing the home at the profile base dir, agy having no variable of its own', () => {
    expect(adapterFor('agy').configDirEnv('/home/u/.aimux/profiles/a/.gemini/antigravity-cli', false)).toEqual({
      [HOME_VAR]: '/home/u/.aimux/profiles/a',
      AIMUX_REAL_HOME: userHome(),
    });
  });

  it("gives a source profile its own home back, so a run inside another agy profile can't leak in", () => {
    expect(adapterFor('agy').configDirEnv('/home/u/.gemini/antigravity-cli', true)[HOME_VAR]).toBe('/home/u');
  });
});

describe('agyAdapter sharing + auth metadata', () => {
  it('shares nothing from its own dir: skills, plugins and MCP live in ~/.gemini/config, reached through the home', () => {
    const a = adapterFor('agy');
    const empty = new Set<string>();
    for (const entry of ['antigravity-oauth-token', 'settings.json', 'conversations', 'brain', 'history.jsonl', 'cache', 'knowledge']) {
      expect(a.isShared(entry, empty)).toBe(false);
    }
  });

  it('proves auth via antigravity-oauth-token and sources from ~/.gemini/antigravity-cli', () => {
    const a = adapterFor('agy');
    expect(a.credentialsFile()).toBe('antigravity-oauth-token');
    expect(a.defaultSource()).toBe('~/.gemini/antigravity-cli');
    expect(a.authArgs()).toEqual([]); // no login subcommand; a bare run signs in
  });

  it('resumes by conversation id and refuses a fork, which agy cannot do', () => {
    const a = adapterFor('agy');
    expect(a.resumeArgs('c-1')).toEqual(['--conversation', 'c-1']);
    expect(() => a.resumeArgs('c-1', { fork: true })).toThrow(/fork/);
  });

  it('runs headless via -p on stdout and needs no overlay/extra links', () => {
    const a = adapterFor('agy');
    expect(a.headlessArgs('hi')).toEqual(['-p', 'hi']);
    expect(a.headlessCaptureToFile).toBe(false);
    expect(a.globalArgs(undefined)).toEqual([]);
    expect(a.extraLinks('/home/u/.gemini/antigravity-cli')).toEqual([]);
  });

  it('shares ~/.gemini/config, where skills, plugins and MCP servers live', () => {
    expect(adapterFor('agy').sharedHomeDirs).toEqual(['.gemini/config']);
  });

  it('other CLIs keep their own config-dir variable and need no stand-in home', () => {
    for (const cli of ['claude', 'codex', 'gemini']) expect(adapterFor(cli).homeDir).toBeUndefined();
  });
});

describe('the home aimux works from', () => {
  // An aimux the agy agent starts sees the stand-in as $HOME. Profile paths built from it
  // sent every claude profile's links through the agy profile.
  it('is the real one handed down in AIMUX_REAL_HOME', () => {
    const saved = process.env.AIMUX_REAL_HOME;
    process.env.AIMUX_REAL_HOME = '/home/real';
    try {
      expect(userHome()).toBe('/home/real');
      expect(expandHome('~/.claude')).toBe('/home/real/.claude');
    } finally {
      if (saved === undefined) delete process.env.AIMUX_REAL_HOME;
      else process.env.AIMUX_REAL_HOME = saved;
    }
  });
});
