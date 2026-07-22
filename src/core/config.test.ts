import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { setAimuxDir } from './paths.js';
import {
  validateConfig,
  createDefaultConfig,
  addProfile,
  removeProfile,
  getProfile,
  getSourceProfile,
  saveConfig,
  loadConfig,
  recordHistory,
  getLastProfile,
  matchGlob,
  resolveProfileForDir,
} from './config.js';

const TEST_DIR = join(tmpdir(), `aimux-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setAimuxDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('validateConfig', () => {
  it('passes for valid config', () => {
    const config = createDefaultConfig('~/.claude');
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects missing version', () => {
    const errors = validateConfig({ shared_source: '~/.claude', profiles: {}, private: [] });
    expect(errors.some(e => e.includes('version'))).toBe(true);
  });

  it('rejects missing source profile', () => {
    const config = {
      version: 1,
      shared_source: '~/.claude',
      profiles: { work: { cli: 'claude', path: '~/.aimux/profiles/work' } },
      private: [],
    };
    expect(validateConfig(config).some(e => e.includes('is_source'))).toBe(true);
  });

  it('rejects multiple source profiles', () => {
    const config = {
      version: 1,
      shared_source: '~/.claude',
      profiles: {
        a: { cli: 'claude', path: '/a', is_source: true },
        b: { cli: 'claude', path: '/b', is_source: true },
      },
      private: [],
    };
    expect(validateConfig(config).some(e => e.includes('Only one'))).toBe(true);
  });
});

describe('createDefaultConfig', () => {
  it('creates config with main as source', () => {
    const config = createDefaultConfig('~/.claude');
    expect(config.version).toBe(1);
    expect(config.shared_source).toBe('~/.claude');
    expect(config.profiles.main.is_source).toBe(true);
    expect(config.profiles.main.cli).toBe('claude');
    expect(config.private.length).toBeGreaterThan(0);
  });
});

describe('addProfile / removeProfile', () => {
  it('adds a profile', () => {
    let config = createDefaultConfig('~/.claude');
    config = addProfile(config, 'work', { model: 'claude-opus-4-6' });
    expect(config.profiles.work).toBeDefined();
    expect(config.profiles.work.model).toBe('claude-opus-4-6');
    expect(config.profiles.work.path).toBe('~/.aimux/profiles/work');
  });

  it('rejects duplicate profile', () => {
    let config = createDefaultConfig('~/.claude');
    config = addProfile(config, 'work', {});
    expect(() => addProfile(config, 'work', {})).toThrow('already exists');
  });

  it('removes a profile', () => {
    let config = createDefaultConfig('~/.claude');
    config = addProfile(config, 'work', {});
    config = removeProfile(config, 'work');
    expect(config.profiles.work).toBeUndefined();
  });

  it('cannot remove source profile', () => {
    const config = createDefaultConfig('~/.claude');
    expect(() => removeProfile(config, 'main')).toThrow('Cannot remove source');
  });
});

describe('getProfile / getSourceProfile', () => {
  it('gets profile by name', () => {
    const config = createDefaultConfig('~/.claude');
    expect(getProfile(config, 'main').cli).toBe('claude');
  });

  it('throws for missing profile', () => {
    const config = createDefaultConfig('~/.claude');
    expect(() => getProfile(config, 'nope')).toThrow('not found');
  });

  it('finds source profile', () => {
    const config = createDefaultConfig('~/.claude');
    const [name, profile] = getSourceProfile(config);
    expect(name).toBe('main');
    expect(profile.is_source).toBe(true);
  });
});

describe('saveConfig / loadConfig', () => {
  it('round-trips config through YAML', () => {
    let config = createDefaultConfig('~/.claude');
    config = addProfile(config, 'work', { model: 'opus-4-6' });
    saveConfig(config);

    const loaded = loadConfig();
    expect(loaded).not.toBeNull();
    expect(loaded!.profiles.work.model).toBe('opus-4-6');
    expect(loaded!.profiles.main.is_source).toBe(true);
  });

  it('returns null when no config', () => {
    expect(loadConfig()).toBeNull();
  });
});

describe('history', () => {
  it('records and retrieves last profile', () => {
    recordHistory('/home/user/project-a', 'work');
    expect(getLastProfile('/home/user/project-a')).toBe('work');
    expect(getLastProfile('/home/user/other')).toBeNull();
  });

  it('updates existing entry', () => {
    recordHistory('/home/user/project-a', 'work');
    recordHistory('/home/user/project-a', 'own');
    expect(getLastProfile('/home/user/project-a')).toBe('own');
  });
});

describe('bindings config validation', () => {
  it('validates bindings array structure', () => {
    const config = createDefaultConfig('~/.claude');
    expect(validateConfig(config)).toHaveLength(0);

    // invalid type for bindings
    const badConfig1 = { ...config, bindings: 'not-an-array' };
    expect(validateConfig(badConfig1)).toContain('bindings must be an array of objects');

    // non-object elements
    const badConfig2 = { ...config, bindings: ['string'] };
    expect(validateConfig(badConfig2)).toContain('bindings[0] must be an object');

    // missing fields
    const badConfig3 = { ...config, bindings: [{}] };
    expect(validateConfig(badConfig3)).toContain('bindings[0]: pattern must be a non-empty string');
    expect(validateConfig(badConfig3)).toContain('bindings[0]: profile must be a non-empty string');

    // non-existent profile
    const badConfig4 = { ...config, bindings: [{ pattern: '~/work/**', profile: 'non-existent' }] };
    expect(validateConfig(badConfig4)).toContain("bindings[0]: profile 'non-existent' does not exist in profiles");

    // valid binding
    const goodConfig = { ...config, bindings: [{ pattern: '~/work/**', profile: 'main' }] };
    expect(validateConfig(goodConfig)).toHaveLength(0);
  });
});

describe('matchGlob', () => {
  it('matches exact paths', () => {
    expect(matchGlob('/home/user/work', '/home/user/work')).toBe(true);
    expect(matchGlob('/home/user/work', '/home/user/other')).toBe(false);
  });

  it('anchors a relative pattern to $HOME, not to process.cwd()', () => {
    // Regression: `resolve(pattern)` used the CWD, so the same binding in config.yaml
    // matched different directories depending on where `aimux` happened to be run.
    const home = homedir();
    const original = process.cwd();
    try {
      process.chdir(tmpdir());
      expect(matchGlob(join(home, 'work', 'proj'), 'work/**')).toBe(true);
      expect(matchGlob(join(tmpdir(), 'work', 'proj'), 'work/**')).toBe(false);
    } finally {
      process.chdir(original);
    }
  });

  it('matches segments using *', () => {
    expect(matchGlob('/home/user/work/project', '/home/user/*/project')).toBe(true);
    expect(matchGlob('/home/user/work/project', '/home/user/work/*')).toBe(true);
    expect(matchGlob('/home/user/work/project', '/home/user/*')).toBe(false);
  });

  it('matches recursively using **', () => {
    expect(matchGlob('/home/user/work/project/src/index.ts', '/home/user/work/**')).toBe(true);
    expect(matchGlob('/home/user/work', '/home/user/work/**')).toBe(true);
    expect(matchGlob('/home/user/other', '/home/user/work/**')).toBe(false);
  });
});

describe('resolveProfileForDir', () => {
  it('resolves bound profile when pattern matches', () => {
    let config = createDefaultConfig('~/.claude');
    config = addProfile(config, 'work', { model: 'opus-4-6' });
    config.bindings = [
      { pattern: '~/work/project1/**', profile: 'work' },
      { pattern: '~/personal/**', profile: 'main' }
    ];

    expect(resolveProfileForDir(config, '~/work/project1/src')).toBe('work');
    expect(resolveProfileForDir(config, '~/personal/dev')).toBe('main');
    expect(resolveProfileForDir(config, '~/other')).toBeNull();
  });
});

