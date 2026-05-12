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

  it('converts symlinked private dirs to empty real dirs (jobs/daemon only)', () => {
    seedSharedAndSymlinks('dt');
    const result = isolateProfile(makeConfig(), 'dt');

    // projects is unlinked (it was in config.private) but NOT recreated —
    // share-projects keeps it shared via symlink.
    expect(result.unlinkedSymlinks.sort()).toEqual(['daemon', 'jobs', 'projects']);
    expect(result.createdDirs.sort()).toEqual(['daemon', 'jobs']);

    for (const name of ['jobs', 'daemon']) {
      const target = join(PROFILES, 'dt', name);
      expect(existsSync(target)).toBe(true);
      expect(lstatSync(target).isSymbolicLink()).toBe(false);
      expect(lstatSync(target).isDirectory()).toBe(true);
    }
    // projects must NOT be recreated as a real dir
    expect(existsSync(join(PROFILES, 'dt', 'projects'))).toBe(false);
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

describe('shareProjectsForProfile', () => {
  it('symlinks missing projects/ to source', async () => {
    // shared projects/ exists, but profile has none yet
    mkdirSync(join(SHARED, 'projects'), { recursive: true });
    mkdirSync(join(PROFILES, 'dt'), { recursive: true });

    const { shareProjectsForProfile } = await import('./migration.js');
    const result = shareProjectsForProfile(makeConfig(), 'dt');
    expect(result.status).toBe('symlinked');
    expect(lstatSync(join(PROFILES, 'dt', 'projects')).isSymbolicLink()).toBe(true);
  });

  it('reports already-shared when target is a symlink', async () => {
    mkdirSync(join(SHARED, 'projects'), { recursive: true });
    mkdirSync(join(PROFILES, 'dt'), { recursive: true });
    symlinkSync(join(SHARED, 'projects'), join(PROFILES, 'dt', 'projects'));

    const { shareProjectsForProfile } = await import('./migration.js');
    const result = shareProjectsForProfile(makeConfig(), 'dt');
    expect(result.status).toBe('already-shared');
  });

  it('removes empty real projects/ dir and replaces with symlink', async () => {
    mkdirSync(join(SHARED, 'projects'), { recursive: true });
    mkdirSync(join(PROFILES, 'dt', 'projects'), { recursive: true });

    const { shareProjectsForProfile } = await import('./migration.js');
    const result = shareProjectsForProfile(makeConfig(), 'dt');
    expect(result.status).toBe('symlinked');
    expect(lstatSync(join(PROFILES, 'dt', 'projects')).isSymbolicLink()).toBe(true);
  });

  it('refuses to replace a non-empty real projects/ dir', async () => {
    mkdirSync(join(SHARED, 'projects'), { recursive: true });
    mkdirSync(join(PROFILES, 'dt', 'projects'), { recursive: true });
    writeFileSync(join(PROFILES, 'dt', 'projects', 'leftover.jsonl'), 'data');

    const { shareProjectsForProfile } = await import('./migration.js');
    const result = shareProjectsForProfile(makeConfig(), 'dt');
    expect(result.status).toBe('skipped-non-empty');
    expect(result.contents).toEqual(['leftover.jsonl']);
    // real dir + contents must be untouched
    expect(lstatSync(join(PROFILES, 'dt', 'projects')).isDirectory()).toBe(true);
    expect(existsSync(join(PROFILES, 'dt', 'projects', 'leftover.jsonl'))).toBe(true);
  });

  it('skips when source projects/ is missing', async () => {
    mkdirSync(join(PROFILES, 'dt'), { recursive: true });
    const { shareProjectsForProfile } = await import('./migration.js');
    const result = shareProjectsForProfile(makeConfig(), 'dt');
    expect(result.status).toBe('skipped-missing-source');
  });
});
