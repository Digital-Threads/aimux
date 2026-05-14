import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AimuxConfig } from '../types/index.js';
import { setAimuxDir } from './paths.js';
import { summarizeUsage, parseSinceDuration, totalTokens } from './usage.js';

const TEST_DIR = join(tmpdir(), `aimux-usage-test-${Date.now()}`);

function makeConfig(): AimuxConfig {
  return {
    version: 1,
    shared_source: join(TEST_DIR, 'shared'),
    profiles: {
      main: { cli: 'claude', path: join(TEST_DIR, 'shared'), is_source: true },
      work: { cli: 'claude', path: join(TEST_DIR, 'profiles', 'work') },
    },
    private: ['.credentials.json'],
  };
}

function writeProfileSession(profile: string, sessionId: string, modified: number) {
  const profilePath = profile === 'main' ? join(TEST_DIR, 'shared') : join(TEST_DIR, 'profiles', profile);
  mkdirSync(profilePath, { recursive: true });
  writeFileSync(
    join(profilePath, '.claude.json'),
    JSON.stringify({
      projects: {
        '/tmp/project': {
          lastSessionId: sessionId,
          lastSessionModified: modified,
        },
      },
    }),
  );
}

function writeTranscript(cwdHash: string, sessionId: string, lines: unknown[]) {
  const dir = join(TEST_DIR, 'shared', 'projects', cwdHash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

function assistantLine(sessionId: string, requestId: string, timestamp: string, usage: Record<string, number>) {
  return {
    type: 'assistant',
    requestId,
    timestamp,
    sessionId,
    message: {
      id: `msg-${requestId}`,
      model: 'claude-opus-4-7',
      usage,
    },
  };
}

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setAimuxDir(join(TEST_DIR, '.aimux'));
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('summarizeUsage', () => {
  it('attributes transcript usage to profiles via .claude.json session ownership', () => {
    writeProfileSession('work', 'session-a', 1000);
    writeTranscript('-tmp-project', 'session-a', [
      assistantLine('session-a', 'req-1', '2026-05-14T00:00:00.000Z', {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: 40,
      }),
    ]);

    const summaries = summarizeUsage(makeConfig());
    const work = summaries.find((s) => s.profile === 'work')!;
    expect(work.sessions).toBe(1);
    expect(work.requests).toBe(1);
    expect(totalTokens(work)).toBe(100);
    expect(work.models.get('claude-opus-4-7')).toBe(1);
  });

  it('deduplicates repeated transcript lines for the same requestId', () => {
    writeProfileSession('work', 'session-a', 1000);
    const repeated = assistantLine('session-a', 'req-1', '2026-05-14T00:00:00.000Z', {
      input_tokens: 10,
      output_tokens: 5,
    });
    writeTranscript('-tmp-project', 'session-a', [repeated, repeated]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.requests).toBe(1);
    expect(work.inputTokens).toBe(10);
    expect(work.outputTokens).toBe(5);
  });

  it('filters by profile and since timestamp', () => {
    writeProfileSession('main', 'session-main', 1000);
    writeProfileSession('work', 'session-work', 1000);
    writeTranscript('-tmp-project', 'session-main', [
      assistantLine('session-main', 'req-main', '2026-05-10T00:00:00.000Z', { input_tokens: 100 }),
    ]);
    writeTranscript('-tmp-project', 'session-work', [
      assistantLine('session-work', 'req-old', '2026-05-10T00:00:00.000Z', { input_tokens: 100 }),
      assistantLine('session-work', 'req-new', '2026-05-14T00:00:00.000Z', { input_tokens: 200 }),
    ]);

    const summaries = summarizeUsage(makeConfig(), {
      profile: 'work',
      sinceMs: Date.parse('2026-05-13T00:00:00.000Z'),
    });
    expect(summaries.map((s) => s.profile)).toEqual(['work']);
    expect(summaries[0].requests).toBe(1);
    expect(summaries[0].inputTokens).toBe(200);
  });
});

describe('parseSinceDuration', () => {
  it('parses hours, days, and weeks', () => {
    const now = Date.parse('2026-05-14T00:00:00.000Z');
    expect(parseSinceDuration('24h', now)).toBe(now - 24 * 60 * 60 * 1000);
    expect(parseSinceDuration('7d', now)).toBe(now - 7 * 24 * 60 * 60 * 1000);
    expect(parseSinceDuration('2w', now)).toBe(now - 14 * 24 * 60 * 60 * 1000);
  });

  it('rejects invalid durations', () => {
    expect(() => parseSinceDuration('yesterday')).toThrow('Invalid duration');
  });
});
