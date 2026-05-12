import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listSessions,
  listAllSessions,
  formatRelativeTime,
  shortenPath,
} from './sessions.js';
import type { AimuxConfig } from '../types/index.js';

const TEST_DIR = join(tmpdir(), `aimux-sessions-test-${Date.now()}`);

function makeConfig(): AimuxConfig {
  return {
    version: 1,
    shared_source: join(TEST_DIR, 'shared'),
    profiles: {
      dt: { cli: 'claude', path: join(TEST_DIR, 'profiles', 'dt') },
      own: { cli: 'claude', path: join(TEST_DIR, 'profiles', 'own') },
    },
    private: ['.credentials.json'],
  };
}

function writeState(profile: string, short: string, partial: Record<string, unknown>) {
  const dir = join(TEST_DIR, 'profiles', profile, 'jobs', short);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      state: 'done',
      name: `session-${short}`,
      daemonShort: short,
      sessionId: `${short}-uuid`,
      cwd: '/home/user/proj',
      updatedAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: new Date(Date.now() - 60000).toISOString(),
      ...partial,
    }),
  );
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('listSessions', () => {
  it('returns empty array when jobs dir does not exist', () => {
    const config = makeConfig();
    expect(listSessions(config, 'dt')).toEqual([]);
  });

  it('parses session state files', () => {
    writeState('dt', 'abc12345', { state: 'working', name: 'foo' });
    writeState('dt', 'def67890', { state: 'done', name: 'bar' });

    const sessions = listSessions(makeConfig(), 'dt');
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.name).sort()).toEqual(['bar', 'foo']);
  });

  it('sorts by updatedAt descending', () => {
    const now = Date.now();
    writeState('dt', 'old', { updatedAt: new Date(now - 60000).toISOString(), name: 'old' });
    writeState('dt', 'new', { updatedAt: new Date(now - 1000).toISOString(), name: 'new' });

    const sessions = listSessions(makeConfig(), 'dt');
    expect(sessions[0].name).toBe('new');
    expect(sessions[1].name).toBe('old');
  });

  it('skips dirs without state.json', () => {
    const dir = join(TEST_DIR, 'profiles', 'dt', 'jobs', 'no-state');
    mkdirSync(dir, { recursive: true });

    const sessions = listSessions(makeConfig(), 'dt');
    expect(sessions).toEqual([]);
  });

  it('skips dispatch/pins entries and dotfiles', () => {
    mkdirSync(join(TEST_DIR, 'profiles', 'dt', 'jobs', 'dispatch'), { recursive: true });
    writeFileSync(join(TEST_DIR, 'profiles', 'dt', 'jobs', 'pins.json'), '[]');
    writeState('dt', 'real', {});

    const sessions = listSessions(makeConfig(), 'dt');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].short).toBe('real');
  });

  it('normalizes unknown states', () => {
    writeState('dt', 'x', { state: 'something-new' });
    const sessions = listSessions(makeConfig(), 'dt');
    expect(sessions[0].state).toBe('unknown');
  });

  it('tolerates malformed json', () => {
    const dir = join(TEST_DIR, 'profiles', 'dt', 'jobs', 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), '{not valid');
    writeState('dt', 'good', {});

    const sessions = listSessions(makeConfig(), 'dt');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].short).toBe('good');
  });
});

describe('listAllSessions', () => {
  it('returns sessions for every profile', () => {
    writeState('dt', 'a', {});
    writeState('own', 'b', {});
    writeState('own', 'c', {});

    const all = listAllSessions(makeConfig());
    expect(all.get('dt')?.length).toBe(1);
    expect(all.get('own')?.length).toBe(2);
  });

  it('includes profiles with no sessions', () => {
    const all = listAllSessions(makeConfig());
    expect(all.has('dt')).toBe(true);
    expect(all.has('own')).toBe(true);
    expect(all.get('dt')).toEqual([]);
  });
});

describe('formatRelativeTime', () => {
  const now = 1_000_000_000_000;
  it('formats seconds', () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe('5s');
  });
  it('formats minutes', () => {
    expect(formatRelativeTime(now - 2 * 60_000, now)).toBe('2m');
  });
  it('formats hours', () => {
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe('3h');
  });
  it('formats days', () => {
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2d');
  });
  it('clamps negative diffs', () => {
    expect(formatRelativeTime(now + 5_000, now)).toBe('0s');
  });
});

describe('shortenPath', () => {
  it('replaces home with ~', () => {
    expect(shortenPath('/home/user/proj/x', '/home/user')).toBe('~/proj/x');
  });
  it('leaves paths outside home intact', () => {
    expect(shortenPath('/etc/hosts', '/home/user')).toBe('/etc/hosts');
  });
  it('handles empty home', () => {
    expect(shortenPath('/foo', '')).toBe('/foo');
  });
  it('handles empty input', () => {
    expect(shortenPath('', '/home/user')).toBe('');
  });
});
