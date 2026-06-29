import { describe, it, expect } from 'vitest';
import { adapterFor } from './index.js';

describe('geminiAdapter run-path', () => {
  it('is selected for cli "gemini"', () => {
    expect(adapterFor('gemini').id).toBe('gemini');
  });

  it('emits -m <model> when set and not a subcommand', () => {
    const a = adapterFor('gemini');
    expect(a.modelArgs({ model: 'gemini-2.5-pro', isSubcommand: false, userPassedModel: false, userPassedFallback: false }))
      .toEqual(['-m', 'gemini-2.5-pro']);
  });

  it('omits the model flag for a subcommand or a user-passed model', () => {
    const a = adapterFor('gemini');
    expect(a.modelArgs({ model: 'm', isSubcommand: true, userPassedModel: false, userPassedFallback: false })).toEqual([]);
    expect(a.modelArgs({ model: 'm', isSubcommand: false, userPassedModel: true, userPassedFallback: false })).toEqual([]);
  });

  it('isolates via GEMINI_CLI_HOME = parent of the .gemini profile dir', () => {
    const a = adapterFor('gemini');
    // gemini reads <GEMINI_CLI_HOME>/.gemini, and the profile dir IS that .gemini.
    expect(a.configDirEnv('/home/u/.aimux/profiles/g/.gemini', false)).toEqual({
      GEMINI_CLI_HOME: '/home/u/.aimux/profiles/g',
    });
  });

  it('sets no config-dir env for a source profile', () => {
    expect(adapterFor('gemini').configDirEnv('/home/u/.gemini', true)).toEqual({});
  });

  it('places the profile config in a .gemini subdir', () => {
    expect(adapterFor('gemini').configPathFor!('~/.aimux/profiles/g')).toBe('~/.aimux/profiles/g/.gemini');
  });
});

describe('geminiAdapter sharing + auth metadata', () => {
  it('shares only the knowledge allowlist, never auth/settings', () => {
    const a = adapterFor('gemini');
    const empty = new Set<string>();
    for (const shared of ['GEMINI.md', 'skills', 'commands', 'extensions', 'memories']) {
      expect(a.isShared(shared, empty)).toBe(true);
    }
    for (const priv of ['oauth_creds.json', 'google_accounts.json', 'settings.json', 'history', 'projects.json', 'state.json']) {
      expect(a.isShared(priv, empty)).toBe(false);
    }
  });

  it('proves auth via oauth_creds.json and sources from ~/.gemini', () => {
    const a = adapterFor('gemini');
    expect(a.credentialsFile()).toBe('oauth_creds.json');
    expect(a.defaultSource()).toBe('~/.gemini');
    expect(a.authArgs()).toEqual([]); // no login subcommand; interactive OAuth
  });

  it('runs headless via -p on stdout and needs no overlay/extra links', () => {
    const a = adapterFor('gemini');
    expect(a.headlessArgs('hi')).toEqual(['-p', 'hi']);
    expect(a.headlessCaptureToFile).toBe(false);
    expect(a.globalArgs(undefined)).toEqual([]);
    expect(a.extraLinks('/home/u/.gemini')).toEqual([]);
  });
});

describe('configPathFor default (claude/codex unchanged)', () => {
  it('claude and codex do not relocate the profile dir', () => {
    // configPathFor is optional; absent for claude/codex → base dir used as-is.
    expect(adapterFor('claude').configPathFor).toBeUndefined();
    expect(adapterFor('codex').configPathFor).toBeUndefined();
  });
});
