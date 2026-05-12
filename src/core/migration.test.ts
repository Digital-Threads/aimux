import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  lstatSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolateProfile, isolateAllProfiles } from './migration.js';
import type { AimuxConfig } from '../types/index.js';

const TEST_DIR = join(tmpdir(), `aimux-migration-test-${Date.now()}`);
const SHARED = join(TEST_DIR, 'shared');
const PROFILES = join(TEST_DIR, 'profiles');

function makeConfig(): AimuxConfig {
  return {
    version: 1,
    shared_source: SHARED,
    profiles: {
      main: { cli: 'claude', path: SHARED, is_source: true },
      dt: { cli: 'claude', path: join(PROFILES, 'dt') },
      own: { cli: 'claude', path: join(PROFILES, 'own') },
    },
    private: ['.credentials.json', 'jobs', 'daemon', 'projects'],
  };
}

function seedSharedAndSymlinks(profileName: string) {
  // create shared dirs that the profile will symlink to
  mkdirSync(join(SHARED, 'jobs'), { recursive: true });
  mkdirSync(join(SHARED, 'daemon'), { recursive: true });
  mkdirSync(join(SHARED, 'projects'), { recursive: true });
  writeFileSync(join(SHARED, '.credentials.json'), 'cred');

  const profilePath = join(PROFILES, profileName);
  mkdirSync(profilePath, { recursive: true });
  symlinkSync(join(SHARED, 'jobs'), join(profilePath, 'jobs'));
  symlinkSync(join(SHARED, 'daemon'), join(profilePath, 'daemon'));
  symlinkSync(join(SHARED, 'projects'), join(profilePath, 'projects'));
  // .credentials.json is intentionally NOT symlinked (already private file)
  writeFileSync(join(profilePath, '.credentials.json'), 'own-cred');
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('isolateProfile', () => {
  it('skips source profiles', () => {
    seedSharedAndSymlinks('dt');
    const result = isolateProfile(makeConfig(), 'main');
    expect(result.unlinkedSymlinks).toEqual([]);
    expect(result.createdDirs).toEqual([]);
  });

  it('converts symlinked private dirs to empty real dirs', () => {
    seedSharedAndSymlinks('dt');
    const result = isolateProfile(makeConfig(), 'dt');

    expect(result.unlinkedSymlinks.sort()).toEqual(['daemon', 'jobs', 'projects']);
    expect(result.createdDirs.sort()).toEqual(['daemon', 'jobs', 'projects']);

    for (const name of ['jobs', 'daemon', 'projects']) {
      const target = join(PROFILES, 'dt', name);
      expect(existsSync(target)).toBe(true);
      expect(lstatSync(target).isSymbolicLink()).toBe(false);
      expect(lstatSync(target).isDirectory()).toBe(true);
    }
  });

  it('preserves existing real private files', () => {
    seedSharedAndSymlinks('dt');
    const before = readFileSync(join(PROFILES, 'dt', '.credentials.json'), 'utf-8');
    isolateProfile(makeConfig(), 'dt');
    const after = readFileSync(join(PROFILES, 'dt', '.credentials.json'), 'utf-8');
    expect(after).toBe(before);
    expect(after).toBe('own-cred');
  });

  it('does not touch shared source data', () => {
    seedSharedAndSymlinks('dt');
    isolateProfile(makeConfig(), 'dt');
    expect(existsSync(join(SHARED, 'jobs'))).toBe(true);
    expect(existsSync(join(SHARED, 'daemon'))).toBe(true);
    expect(existsSync(join(SHARED, 'projects'))).toBe(true);
  });

  it('is idempotent — second run reports already-isolated', () => {
    seedSharedAndSymlinks('dt');
    isolateProfile(makeConfig(), 'dt');
    const second = isolateProfile(makeConfig(), 'dt');
    expect(second.unlinkedSymlinks).toEqual([]);
    expect(second.createdDirs).toEqual([]);
  });

  it('throws on unknown profile', () => {
    expect(() => isolateProfile(makeConfig(), 'ghost')).toThrow('not found');
  });
});

describe('isolateAllProfiles', () => {
  it('isolates all non-source profiles', () => {
    seedSharedAndSymlinks('dt');
    seedSharedAndSymlinks('own');

    const result = isolateAllProfiles(makeConfig());
    expect(result.perProfile.map((r) => r.profile).sort()).toEqual(['dt', 'own']);
    for (const r of result.perProfile) {
      expect(r.unlinkedSymlinks.sort()).toEqual(['daemon', 'jobs', 'projects']);
    }
  });

  it('skips the source profile', () => {
    seedSharedAndSymlinks('dt');
    const result = isolateAllProfiles(makeConfig());
    expect(result.perProfile.find((r) => r.profile === 'main')).toBeUndefined();
  });
});
