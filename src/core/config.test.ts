import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
