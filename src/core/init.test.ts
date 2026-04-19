import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setAimuxDir } from './paths.js';
import { initFromSource } from './init.js';

const TEST_DIR = join(tmpdir(), `aimux-init-test-${Date.now()}`);
const AIMUX_DIR = join(TEST_DIR, 'aimux');
const SHARED_DIR = join(TEST_DIR, 'claude-source');

beforeEach(() => {
  mkdirSync(SHARED_DIR, { recursive: true });
  mkdirSync(AIMUX_DIR, { recursive: true });
  setAimuxDir(AIMUX_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function seedSource(files: string[]) {
  for (const f of files) {
    writeFileSync(join(SHARED_DIR, f), `content-${f}`);
  }
}

function seedExistingProfile(name: string, files: string[]) {
  const dir = join(TEST_DIR, name);
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    writeFileSync(join(dir, f), `private-${f}`);
  }
  return dir;
}

describe('initFromSource', () => {
  it('creates config and aimux structure', () => {
    seedSource(['settings.json', 'CLAUDE.md']);
    const result = initFromSource(SHARED_DIR);

    expect(result.configCreated).toBe(true);
    expect(result.source).toBe(SHARED_DIR);
    expect(existsSync(join(AIMUX_DIR, 'config.yaml'))).toBe(true);
  });

  it('creates profile with symlinks', () => {
    seedSource(['settings.json', 'CLAUDE.md', '.credentials.json']);

    const result = initFromSource(SHARED_DIR, [
      { name: 'work' },
    ]);

    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].name).toBe('work');
    expect(result.profiles[0].sync.created).toContain('settings.json');
    expect(result.profiles[0].sync.created).toContain('CLAUDE.md');
    expect(result.profiles[0].sync.private).toContain('.credentials.json');

    const profileDir = join(AIMUX_DIR, 'profiles', 'work');
    expect(existsSync(profileDir)).toBe(true);

    const link = readlinkSync(join(profileDir, 'settings.json'));
    expect(link).toBe(join(SHARED_DIR, 'settings.json'));
  });

  it('copies private files from existing directory', () => {
    seedSource(['settings.json', '.credentials.json']);
    const existingDir = seedExistingProfile('claude-work', ['.credentials.json', '.claude.json']);

    const result = initFromSource(SHARED_DIR, [
      { name: 'work', existingPath: existingDir },
    ]);

    expect(result.profiles[0].privatesCopied).toContain('.credentials.json');
    expect(result.profiles[0].privatesCopied).toContain('.claude.json');

    const profileDir = join(AIMUX_DIR, 'profiles', 'work');
    expect(existsSync(join(profileDir, '.credentials.json'))).toBe(true);
    expect(existsSync(join(profileDir, '.claude.json'))).toBe(true);
  });

  it('creates multiple profiles', () => {
    seedSource(['settings.json']);

    const result = initFromSource(SHARED_DIR, [
      { name: 'work', model: 'claude-opus-4-6' },
      { name: 'own', model: 'claude-opus-4-6' },
    ]);

    expect(result.profiles).toHaveLength(2);
    expect(existsSync(join(AIMUX_DIR, 'profiles', 'work'))).toBe(true);
    expect(existsSync(join(AIMUX_DIR, 'profiles', 'own'))).toBe(true);
  });

  it('throws if already initialized', () => {
    seedSource(['settings.json']);
    initFromSource(SHARED_DIR);

    expect(() => initFromSource(SHARED_DIR)).toThrow('already initialized');
  });

  it('throws if source not found', () => {
    expect(() => initFromSource('/nonexistent/path')).toThrow('Source directory not found');
  });

  it('handles private directories (statsig, telemetry)', () => {
    seedSource(['settings.json']);
    const existingDir = join(TEST_DIR, 'claude-existing');
    mkdirSync(existingDir, { recursive: true });
    mkdirSync(join(existingDir, 'statsig'), { recursive: true });
    writeFileSync(join(existingDir, 'statsig', 'flags.json'), '{}');

    const result = initFromSource(SHARED_DIR, [
      { name: 'work', existingPath: existingDir },
    ]);

    expect(result.profiles[0].privatesCopied).toContain('statsig');
    const profileDir = join(AIMUX_DIR, 'profiles', 'work');
    expect(existsSync(join(profileDir, 'statsig', 'flags.json'))).toBe(true);
  });

  it('skips symlinked private files in existing dir', () => {
    seedSource(['settings.json', '.credentials.json']);
    const existingDir = seedExistingProfile('claude-work', []);

    const { symlinkSync } = require('node:fs');
    symlinkSync(
      join(SHARED_DIR, '.credentials.json'),
      join(existingDir, '.credentials.json'),
    );

    const result = initFromSource(SHARED_DIR, [
      { name: 'work', existingPath: existingDir },
    ]);

    expect(result.profiles[0].privatesCopied).not.toContain('.credentials.json');
  });
});
