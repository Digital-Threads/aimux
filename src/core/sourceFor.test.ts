import { describe, it, expect } from 'vitest';
import { sourceFor } from './config.js';
import type { AimuxConfig } from '../types/index.js';

function cfg(extra?: Partial<AimuxConfig>): AimuxConfig {
  return {
    version: 1,
    shared_source: '/home/u/.claude',
    profiles: {},
    private: [],
    ...extra,
  };
}

describe('sourceFor', () => {
  it('falls back to legacy shared_source for claude when no shared_sources', () => {
    expect(sourceFor(cfg(), 'claude')).toBe('/home/u/.claude');
  });

  it('falls back to legacy shared_source for any cli when no shared_sources', () => {
    expect(sourceFor(cfg(), 'codex')).toBe('/home/u/.claude');
  });

  it('uses the per-CLI source when present', () => {
    const config = cfg({ shared_sources: { claude: '/home/u/.claude', codex: '/home/u/.codex' } });
    expect(sourceFor(config, 'claude')).toBe('/home/u/.claude');
    expect(sourceFor(config, 'codex')).toBe('/home/u/.codex');
  });

  it('falls back to shared_source for a cli missing from shared_sources', () => {
    const config = cfg({ shared_sources: { claude: '/home/u/.claude' } });
    expect(sourceFor(config, 'codex')).toBe('/home/u/.claude');
  });
});
