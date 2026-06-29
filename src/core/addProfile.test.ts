import { describe, it, expect } from 'vitest';
import { addProfile } from './config.js';
import type { AimuxConfig } from '../types/index.js';

function base(): AimuxConfig {
  return {
    version: 1,
    shared_source: '/home/u/.claude',
    profiles: { main: { cli: 'claude', path: '/home/u/.claude', is_source: true } },
    private: [],
  };
}

describe('addProfile cli + shared_sources', () => {
  it('creates a claude profile without touching shared_sources', () => {
    const updated = addProfile(base(), 'work', {});
    expect(updated.profiles.work.cli).toBe('claude');
    expect(updated.shared_sources).toBeUndefined();
  });

  it('registers shared_sources for a codex profile (default ~/.codex)', () => {
    const updated = addProfile(base(), 'codework', { cli: 'codex' });
    expect(updated.profiles.codework.cli).toBe('codex');
    expect(updated.shared_sources?.codex).toBe('~/.codex');
  });

  it('does not overwrite an existing per-CLI source', () => {
    const cfg = { ...base(), shared_sources: { codex: '/custom/codex' } };
    const updated = addProfile(cfg, 'codework', { cli: 'codex' });
    expect(updated.shared_sources?.codex).toBe('/custom/codex');
  });

  it('puts a gemini profile in a .gemini dir and registers ~/.gemini as its source', () => {
    const updated = addProfile(base(), 'gem', { cli: 'gemini' });
    expect(updated.profiles.gem.cli).toBe('gemini');
    // The profile path IS gemini's config dir (.gemini), so GEMINI_CLI_HOME points one up.
    expect(updated.profiles.gem.path).toBe('~/.aimux/profiles/gem/.gemini');
    expect(updated.shared_sources?.gemini).toBe('~/.gemini');
  });

  it('keeps claude/codex profile paths unchanged (no .gemini suffix)', () => {
    expect(addProfile(base(), 'work', {}).profiles.work.path).toBe('~/.aimux/profiles/work');
    expect(addProfile(base(), 'cx', { cli: 'codex' }).profiles.cx.path).toBe('~/.aimux/profiles/cx');
  });
});
