import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync, rmSync, writeFileSync, readFileSync, readlinkSync, symlinkSync,
  readdirSync, lstatSync, existsSync,
} from 'node:fs';
import { join, sep, resolve } from 'node:path';
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
  rewritePluginPaths,
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

describe('syncProfile reclaims codex session-index DB', () => {
  it('replaces a stale REAL state_<N>.sqlite in the profile with the source symlink', () => {
    const codexSrc = join(TEST_DIR, 'codex-src');
    const profileDir = join(PROFILES_DIR, 'cx');
    mkdirSync(codexSrc, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(codexSrc, 'state_5.sqlite'), 'SOURCE-INDEX-126');
    writeFileSync(join(codexSrc, 'auth.json'), 'src-auth');
    // The profile already has a stale, real (non-symlink) index from an earlier run.
    writeFileSync(join(profileDir, 'state_5.sqlite'), 'STALE-INDEX-4');

    const config = makeConfig({
      shared_sources: { codex: codexSrc },
      profiles: {
        main: { cli: 'claude', path: SHARED_DIR, is_source: true },
        cx: { cli: 'codex', path: profileDir },
      },
    });
    const result = syncProfile(config, 'cx');

    const dbPath = join(profileDir, 'state_5.sqlite');
    expect(lstatSync(dbPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(dbPath, 'utf-8')).toBe('SOURCE-INDEX-126'); // now reads source
    expect(result.repaired).toContain('state_5.sqlite');
    expect(result.conflicts).not.toContain('state_5.sqlite');
    // auth.json is private — never shared, never reclaimed.
    expect(result.private).toContain('auth.json');
  });

  it('does NOT reclaim a directory at the entry path — falls through to conflicts (no EISDIR)', () => {
    const codexSrc = join(TEST_DIR, 'codex-src-dir');
    const profileDir = join(PROFILES_DIR, 'cxdir');
    mkdirSync(codexSrc, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(codexSrc, 'state_5.sqlite'), 'SOURCE');
    // Pathological: a real DIRECTORY where the DB belongs. unlinkSync would EISDIR
    // and abort the whole sync, so the isFile() guard must skip it to conflicts.
    mkdirSync(join(profileDir, 'state_5.sqlite'), { recursive: true });

    const config = makeConfig({
      shared_sources: { codex: codexSrc },
      profiles: {
        main: { cli: 'claude', path: SHARED_DIR, is_source: true },
        cxdir: { cli: 'codex', path: profileDir },
      },
    });
    // Must not throw, and must record a conflict rather than reclaiming.
    const result = syncProfile(config, 'cxdir');
    expect(result.conflicts).toContain('state_5.sqlite');
    expect(result.repaired).not.toContain('state_5.sqlite');
    expect(lstatSync(join(profileDir, 'state_5.sqlite')).isDirectory()).toBe(true);
  });
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
    expect(result.conflicts).toContain('settings.json');
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

  it('reports local shared-file conflicts', () => {
    seedShared(['settings.json']);
    const config = makeConfig();
    const workDir = join(PROFILES_DIR, 'work');
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, 'settings.json'), 'local override');

    const report = checkProfileHealth(config, 'work');
    expect(report.conflicts).toContain('settings.json');
    expect(report.valid).not.toContain('settings.json');
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

const SENTINEL = '.aimux-managed';

function seedSharedPlugins() {
  const pdir = join(SHARED_DIR, 'plugins');
  mkdirSync(join(pdir, 'marketplaces', 'mk1'), { recursive: true });
  writeFileSync(join(pdir, 'marketplaces', 'mk1', '.marker'), 'mk1');
  mkdirSync(join(pdir, 'cache', 'mk1', 'p1'), { recursive: true });
  mkdirSync(join(pdir, 'data'), { recursive: true });
  const extDir = join(TEST_DIR, 'external-ext');
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(pdir, 'known_marketplaces.json'), JSON.stringify({
    mk1: { installLocation: join(pdir, 'marketplaces', 'mk1'), source: { source: 'github', repo: 'a/b' } },
    ext: { installLocation: extDir, source: { source: 'directory', path: extDir } },
  }, null, 2));
  writeFileSync(join(pdir, 'installed_plugins.json'), JSON.stringify({
    version: 1,
    plugins: { 'p1@mk1': [{ installLocation: join(pdir, 'cache', 'mk1', 'p1'), projectPath: join(TEST_DIR, 'someproject') }] },
  }, null, 2));
  return { pdir, extDir };
}

describe('rewritePluginPaths', () => {
  const from = join('/src', 'plugins');
  const to = join('/dst', 'plugins');

  it('rewrites an exact prefix match', () => {
    expect(rewritePluginPaths(from, from, to)).toBe(to);
  });

  it('rewrites a path under the prefix', () => {
    expect(rewritePluginPaths(join(from, 'marketplaces', 'x'), from, to))
      .toBe(join(to, 'marketplaces', 'x'));
  });

  it('leaves non-matching strings untouched', () => {
    expect(rewritePluginPaths('/home/user/project', from, to)).toBe('/home/user/project');
    // not a path-segment boundary -> must NOT match
    expect(rewritePluginPaths('/src/pluginsX/y', from, to)).toBe('/src/pluginsX/y');
  });

  it('recurses objects/arrays and leaves non-strings', () => {
    const input = { a: join(from, 'm'), b: [join(from, 'n'), 5, true, null], c: { d: '/other' } };
    expect(rewritePluginPaths(input, from, to)).toEqual({
      a: join(to, 'm'), b: [join(to, 'n'), 5, true, null], c: { d: '/other' },
    });
  });
});

describe('syncProfile plugins layout', () => {
  it('builds a real plugins dir with symlinked content and projected json', () => {
    seedShared(['settings.json']);
    const { pdir, extDir } = seedSharedPlugins();
    const config = makeConfig();
    const result = syncProfile(config, 'work');

    const ppdir = join(PROFILES_DIR, 'work', 'plugins');
    expect(lstatSync(ppdir).isSymbolicLink()).toBe(false);
    expect(lstatSync(ppdir).isDirectory()).toBe(true);
    expect(result.created).toContain('plugins');
    expect(existsSync(join(ppdir, SENTINEL))).toBe(true);

    expect(lstatSync(join(ppdir, 'marketplaces')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(ppdir, 'marketplaces'))).toBe(join(pdir, 'marketplaces'));
    expect(lstatSync(join(ppdir, 'cache')).isSymbolicLink()).toBe(true);

    expect(lstatSync(join(ppdir, 'known_marketplaces.json')).isSymbolicLink()).toBe(false);
    const km = JSON.parse(readFileSync(join(ppdir, 'known_marketplaces.json'), 'utf8'));
    expect(km.mk1.installLocation).toBe(join(ppdir, 'marketplaces', 'mk1'));
    expect(km.ext.installLocation).toBe(extDir);

    const ip = JSON.parse(readFileSync(join(ppdir, 'installed_plugins.json'), 'utf8'));
    expect(ip.plugins['p1@mk1'][0].installLocation).toBe(join(ppdir, 'cache', 'mk1', 'p1'));
    expect(ip.plugins['p1@mk1'][0].projectPath).toBe(join(TEST_DIR, 'someproject'));

    // projected installLocation satisfies claude's prefix check
    const base = resolve(join(ppdir, 'marketplaces'));
    const o = resolve(km.mk1.installLocation);
    expect(o === base || o.startsWith(base + sep)).toBe(true);
  });

  it('is idempotent on re-sync', () => {
    seedShared(['settings.json']);
    seedSharedPlugins();
    const config = makeConfig();
    syncProfile(config, 'work');
    const result2 = syncProfile(config, 'work');

    const ppdir = join(PROFILES_DIR, 'work', 'plugins');
    expect(result2.conflicts).not.toContain('plugins');
    expect(existsSync(join(ppdir, SENTINEL))).toBe(true);
    const km = JSON.parse(readFileSync(join(ppdir, 'known_marketplaces.json'), 'utf8'));
    expect(km.mk1.installLocation).toBe(join(ppdir, 'marketplaces', 'mk1'));
  });

  it('converts an old whole-dir plugins symlink to the new layout', () => {
    seedShared(['settings.json']);
    const { pdir } = seedSharedPlugins();
    const config = makeConfig();
    const workDir = join(PROFILES_DIR, 'work');
    mkdirSync(workDir, { recursive: true });
    symlinkSync(pdir, join(workDir, 'plugins'));

    syncProfile(config, 'work');

    const ppdir = join(workDir, 'plugins');
    expect(lstatSync(ppdir).isSymbolicLink()).toBe(false);
    expect(existsSync(join(ppdir, SENTINEL))).toBe(true);
    expect(lstatSync(join(ppdir, 'marketplaces')).isSymbolicLink()).toBe(true);
  });

  it('back-merges a profile-local marketplace into source', () => {
    seedShared(['settings.json']);
    const { pdir } = seedSharedPlugins();
    const config = makeConfig();
    syncProfile(config, 'work');

    const ppdir = join(PROFILES_DIR, 'work', 'plugins');
    const km = JSON.parse(readFileSync(join(ppdir, 'known_marketplaces.json'), 'utf8'));
    km.localmk = { installLocation: join(ppdir, 'marketplaces', 'localmk'), source: { source: 'github', repo: 'c/d' } };
    writeFileSync(join(ppdir, 'known_marketplaces.json'), JSON.stringify(km, null, 2));

    syncProfile(config, 'work');

    const srcKm = JSON.parse(readFileSync(join(pdir, 'known_marketplaces.json'), 'utf8'));
    expect(srcKm.localmk).toBeDefined();
    expect(srcKm.localmk.installLocation).toBe(join(pdir, 'marketplaces', 'localmk'));
    expect(srcKm.mk1.installLocation).toBe(join(pdir, 'marketplaces', 'mk1'));

    const km2 = JSON.parse(readFileSync(join(ppdir, 'known_marketplaces.json'), 'utf8'));
    expect(km2.localmk.installLocation).toBe(join(ppdir, 'marketplaces', 'localmk'));
  });

  it('never overwrites an existing source key on back-merge (main wins)', () => {
    seedShared(['settings.json']);
    const { pdir } = seedSharedPlugins();
    const config = makeConfig();
    syncProfile(config, 'work');

    const ppdir = join(PROFILES_DIR, 'work', 'plugins');
    const km = JSON.parse(readFileSync(join(ppdir, 'known_marketplaces.json'), 'utf8'));
    km.mk1.source.repo = 'hacked/repo';
    writeFileSync(join(ppdir, 'known_marketplaces.json'), JSON.stringify(km, null, 2));

    syncProfile(config, 'work');

    const srcKm = JSON.parse(readFileSync(join(pdir, 'known_marketplaces.json'), 'utf8'));
    expect(srcKm.mk1.source.repo).toBe('a/b');
  });

  it('flags a user-owned plugins dir (no sentinel) as a conflict and leaves it', () => {
    seedShared(['settings.json']);
    seedSharedPlugins();
    const config = makeConfig();
    const ppdir = join(PROFILES_DIR, 'work', 'plugins');
    mkdirSync(ppdir, { recursive: true });
    writeFileSync(join(ppdir, 'mine.txt'), 'user data');

    const result = syncProfile(config, 'work');

    expect(result.conflicts).toContain('plugins');
    expect(existsSync(join(ppdir, 'mine.txt'))).toBe(true);
    expect(existsSync(join(ppdir, SENTINEL))).toBe(false);
  });

  it('builds symlinks when source plugins has no json files', () => {
    seedShared(['settings.json']);
    mkdirSync(join(SHARED_DIR, 'plugins', 'marketplaces'), { recursive: true });
    const config = makeConfig();

    const result = syncProfile(config, 'work');

    const ppdir = join(PROFILES_DIR, 'work', 'plugins');
    expect(result.created).toContain('plugins');
    expect(lstatSync(join(ppdir, 'marketplaces')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(ppdir, 'known_marketplaces.json'))).toBe(false);
  });

  it('prunes its own dangling symlinks but leaves a user symlink', () => {
    seedShared(['settings.json']);
    const { pdir } = seedSharedPlugins();
    const config = makeConfig();
    syncProfile(config, 'work');

    const ppdir = join(PROFILES_DIR, 'work', 'plugins');
    // an aimux-style link whose source entry no longer exists
    symlinkSync(join(pdir, 'gone'), join(ppdir, 'gone'));
    // a user's own link pointing outside the source (dangling)
    symlinkSync(join(TEST_DIR, 'user-thing'), join(ppdir, 'user-link'));

    syncProfile(config, 'work');

    const entries = readdirSync(ppdir);
    expect(entries).not.toContain('gone');
    expect(entries).toContain('user-link');
    expect(lstatSync(join(ppdir, 'user-link')).isSymbolicLink()).toBe(true);
  });

  it('does not build a plugins layout for the source profile', () => {
    seedShared(['settings.json']);
    seedSharedPlugins();
    const config = makeConfig();
    const result = syncProfile(config, 'main');
    expect(result.created).not.toContain('plugins');
  });

  it('checkProfileHealth treats a managed plugins dir as valid', () => {
    seedShared(['settings.json']);
    seedSharedPlugins();
    const config = makeConfig();
    syncProfile(config, 'work');

    const report = checkProfileHealth(config, 'work');
    expect(report.valid).toContain('plugins');
    expect(report.conflicts).not.toContain('plugins');
  });
});
