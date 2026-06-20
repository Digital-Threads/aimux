import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, lstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setAimuxDir } from './paths.js';
import { syncProfile } from './symlinks.js';
import type { AimuxConfig } from '../types/index.js';

const TEST_DIR = join(tmpdir(), `aimux-codex-share-${Date.now()}`);
const CODEX_SRC = join(TEST_DIR, 'codex-src');
const CLAUDE_SRC = join(TEST_DIR, 'claude-src');
const PROFILES = join(TEST_DIR, 'profiles');

function config(): AimuxConfig {
  return {
    version: 1,
    shared_source: CLAUDE_SRC,
    shared_sources: { claude: CLAUDE_SRC, codex: CODEX_SRC },
    profiles: {
      main: { cli: 'claude', path: CLAUDE_SRC, is_source: true },
      codework: { cli: 'codex', path: join(PROFILES, 'codework') },
    },
    private: ['.credentials.json', '.claude.json'],
  };
}

beforeEach(() => {
  // Codex source with a mix of knowledge dirs and private state.
  for (const d of ['skills', 'rules', 'memories', 'sessions']) {
    mkdirSync(join(CODEX_SRC, d), { recursive: true });
  }
  writeFileSync(join(CODEX_SRC, 'auth.json'), '{}');
  writeFileSync(join(CODEX_SRC, 'config.toml'), 'model = "x"');
  writeFileSync(join(CODEX_SRC, 'history.jsonl'), '');
  mkdirSync(CLAUDE_SRC, { recursive: true });
  mkdirSync(PROFILES, { recursive: true });
  setAimuxDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('codex profile sharing (allowlist)', () => {
  it('symlinks only knowledge dirs (skills/rules/memories) from the codex source', () => {
    const profileDir = join(PROFILES, 'codework');
    syncProfile(config(), 'codework');

    for (const d of ['skills', 'rules', 'memories']) {
      const p = join(profileDir, d);
      expect(existsSync(p), `${d} should be linked`).toBe(true);
      expect(lstatSync(p).isSymbolicLink(), `${d} should be a symlink`).toBe(true);
    }
  });

  it('does NOT share codex creds/state (auth.json, config.toml, history.jsonl, sessions)', () => {
    const profileDir = join(PROFILES, 'codework');
    const result = syncProfile(config(), 'codework');

    for (const f of ['auth.json', 'config.toml', 'history.jsonl', 'sessions']) {
      expect(existsSync(join(profileDir, f)), `${f} must not be linked`).toBe(false);
      expect(result.private, `${f} reported private`).toContain(f);
    }
  });
});
