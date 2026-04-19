import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readlinkSync, symlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setAimuxDir } from './paths.js';
import { createDefaultConfig, addProfile } from './config.js';
import type { AimuxConfig } from '../types/index.js';
import {
  getSharedElements,
  getPrivateElements,
  syncProfile,
  syncAllProfiles,
  checkProfileHealth,
  checkAllProfiles,
} from './symlinks.js';

const TEST_DIR = join(tmpdir(), `aimux-symlink-test-${Date.now()}`);
const SHARED_DIR = join(TEST_DIR, 'shared');
const PROFILES_DIR = join(TEST_DIR, 'profiles');

function makeConfig(extras?: Partial<AimuxConfig>): AimuxConfig {
  return {
    version: 1,
    shared_source: SHARED_DIR,
    profiles: {
      main: { cli: 'claude', path: SHARED_DIR, is_source: true },
      work: { cli: 'claude', path: join(PROFILES_DIR, 'work') },
    },
    private: ['.credentials.json', '.claude.json'],
    ...extras,
  };
}

function seedShared(files: string[]) {
  for (const f of files) {
    writeFileSync(join(SHARED_DIR, f), `content-${f}`);
  }
}

beforeEach(() => {
  mkdirSync(SHARED_DIR, { recursive: true });
  mkdirSync(PROFILES_DIR, { recursive: true });
  setAimuxDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('getSharedElements', () => {
  it('returns non-private entries', () => {
    seedShared(['settings.json', 'CLAUDE.md', '.credentials.json']);
    const config = makeConfig();
    const shared = getSharedElements(config);
    expect(shared).toContain('settings.json');
    expect(shared).toContain('CLAUDE.md');
    expect(shared).not.toContain('.credentials.json');
  });

  it('throws when source path missing', () => {
    const config = makeConfig({ shared_source: '/nonexistent/path' });
    expect(() => getSharedElements(config)).toThrow('Shared source not found');
  });
});

describe('getPrivateElements', () => {
  it('returns only private entries that exist in source', () => {
    seedShared(['.credentials.json', 'settings.json']);
    const config = makeConfig();
    const priv = getPrivateElements(config);
    expect(priv).toContain('.credentials.json');
    expect(priv).not.toContain('.claude.json');
    expect(priv).not.toContain('settings.json');
  });
});

describe('syncProfile', () => {
  it('creates symlinks for shared elements', () => {
    seedShared(['settings.json', 'CLAUDE.md', '.credentials.json']);
    const config = makeConfig();
    const result = syncProfile(config, 'work');

    expect(result.created).toContain('settings.json');
    expect(result.created).toContain('CLAUDE.md');
    expect(result.private).toContain('.credentials.json');
    expect(result.created).not.toContain('.credentials.json');

    const link = readlinkSync(join(PROFILES_DIR, 'work', 'settings.json'));
    expect(link).toBe(join(SHARED_DIR, 'settings.json'));
  });

  it('skips existing correct symlinks', () => {
    seedShared(['settings.json']);
    const config = makeConfig();
    syncProfile(config, 'work');
    const result2 = syncProfile(config, 'work');
    expect(result2.skipped).toContain('settings.json');
    expect(result2.created).toHaveLength(0);
  });

  it('repairs broken symlinks', () => {
    seedShared(['settings.json']);
    const config = makeConfig();
    const workDir = join(PROFILES_DIR, 'work');
    mkdirSync(workDir, { recursive: true });
    symlinkSync('/wrong/target', join(workDir, 'settings.json'));

    const result = syncProfile(config, 'work');
    expect(result.repaired).toContain('settings.json');

    const link = readlinkSync(join(workDir, 'settings.json'));
    expect(link).toBe(join(SHARED_DIR, 'settings.json'));
  });

  it('skips non-symlink files in profile', () => {
    seedShared(['settings.json']);
    const config = makeConfig();
    const workDir = join(PROFILES_DIR, 'work');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'settings.json'), 'local override');

    const result = syncProfile(config, 'work');
    expect(result.skipped).toContain('settings.json');
  });

  it('returns empty result for source profile', () => {
    seedShared(['settings.json']);
    const config = makeConfig();
    const result = syncProfile(config, 'main');
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('throws for unknown profile', () => {
    const config = makeConfig();
    expect(() => syncProfile(config, 'unknown')).toThrow("not found");
  });

  it('creates profile directory if missing', () => {
    seedShared(['settings.json']);
    const config = makeConfig();
    syncProfile(config, 'work');
    const entries = readdirSync(join(PROFILES_DIR, 'work'));
    expect(entries).toContain('settings.json');
  });
});

describe('syncAllProfiles', () => {
  it('syncs all non-source profiles', () => {
    seedShared(['settings.json']);
    const config = makeConfig();
    const results = syncAllProfiles(config);
    expect(results.size).toBe(2);
    expect(results.get('main')!.created).toHaveLength(0);
    expect(results.get('work')!.created).toContain('settings.json');
  });
});

describe('checkProfileHealth', () => {
  it('reports valid symlinks', () => {
    seedShared(['settings.json', 'CLAUDE.md']);
    const config = makeConfig();
    syncProfile(config, 'work');

    const report = checkProfileHealth(config, 'work');
    expect(report.valid).toContain('settings.json');
    expect(report.valid).toContain('CLAUDE.md');
    expect(report.broken).toHaveLength(0);
    expect(report.missing).toHaveLength(0);
  });

  it('reports missing symlinks', () => {
    seedShared(['settings.json']);
    const config = makeConfig();
    mkdirSync(join(PROFILES_DIR, 'work'), { recursive: true });

    const report = checkProfileHealth(config, 'work');
    expect(report.missing).toContain('settings.json');
  });

  it('reports broken symlinks', () => {
    seedShared(['settings.json']);
    const config = makeConfig();
    const workDir = join(PROFILES_DIR, 'work');
    mkdirSync(workDir, { recursive: true });
    symlinkSync('/nonexistent/target', join(workDir, 'settings.json'));

    const report = checkProfileHealth(config, 'work');
    expect(report.broken).toContain('settings.json');
  });

  it('reports orphaned symlinks', () => {
    seedShared(['settings.json']);
    const config = makeConfig();
    const workDir = join(PROFILES_DIR, 'work');
    mkdirSync(workDir, { recursive: true });
    symlinkSync('/some/old/thing', join(workDir, 'old-file.json'));

    const report = checkProfileHealth(config, 'work');
    expect(report.orphaned).toContain('old-file.json');
  });

  it('reports missing profile directory', () => {
    seedShared(['settings.json']);
    const config = makeConfig();
    const report = checkProfileHealth(config, 'work');
    expect(report.missing).toContain('(profile directory)');
  });

  it('returns empty report for source profile', () => {
    const config = makeConfig();
    const report = checkProfileHealth(config, 'main');
    expect(report.valid).toHaveLength(0);
    expect(report.broken).toHaveLength(0);
  });
});

describe('checkAllProfiles', () => {
  it('checks all profiles', () => {
    seedShared(['settings.json']);
    const config = makeConfig();
    syncProfile(config, 'work');

    const reports = checkAllProfiles(config);
    expect(reports.size).toBe(2);
    expect(reports.get('work')!.valid).toContain('settings.json');
  });
});
