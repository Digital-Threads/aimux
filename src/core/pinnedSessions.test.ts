import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setAimuxDir, resetAimuxDir } from './paths.js';
import { loadPinned, savePinned, togglePinned, getPinnedPath } from './pinnedSessions.js';

const TEST_DIR = join(tmpdir(), `aimux-pinned-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setAimuxDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  resetAimuxDir();
});

describe('pinnedSessions', () => {
  it('returns empty set when no file exists', () => {
    expect(loadPinned().size).toBe(0);
  });

  it('round-trips a pinned set through save/load', () => {
    const set = new Set(['a', 'b']);
    savePinned(set);
    expect(existsSync(getPinnedPath())).toBe(true);
    const loaded = loadPinned();
    expect(loaded.has('a')).toBe(true);
    expect(loaded.has('b')).toBe(true);
    expect(loaded.size).toBe(2);
  });

  it('toggle adds when absent', () => {
    const after = togglePinned('x');
    expect(after.has('x')).toBe(true);
    expect(loadPinned().has('x')).toBe(true);
  });

  it('toggle removes when present', () => {
    savePinned(new Set(['x']));
    const after = togglePinned('x');
    expect(after.has('x')).toBe(false);
    expect(loadPinned().has('x')).toBe(false);
  });

  it('ignores malformed file', () => {
    savePinned(new Set(['x']));
    writeFileSync(getPinnedPath(), '{', 'utf-8');
    expect(loadPinned().size).toBe(0);
  });
});
