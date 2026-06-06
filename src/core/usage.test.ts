import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AimuxConfig } from '../types/index.js';
import { getAimuxDir, setAimuxDir } from './paths.js';
import { summarizeUsage, parseSinceDuration, totalTokens } from './usage.js';

const TEST_DIR = join(tmpdir(), `aimux-usage-test-${Date.now()}`);
const NOW_TS = '2026-05-14T00:00:00.000Z';
const LATER_TS = '2026-05-14T00:00:01.000Z';
const OLD_TS = '2026-05-10T00:00:00.000Z';
const CUTOFF_TS = '2026-05-13T00:00:00.000Z';

let originalAimuxDir: string;

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
  writeProfileSessions(profile, [{ sessionId, modified }]);
}

function writeProfileSessions(
  profile: string,
  sessions: Array<{ sessionId: string; modified: number }>,
) {
  const profilePath = profile === 'main' ? join(TEST_DIR, 'shared') : join(TEST_DIR, 'profiles', profile);
  mkdirSync(profilePath, { recursive: true });
  const projects: Record<string, { lastSessionId: string; lastSessionModified: number }> = {};
  for (const { sessionId, modified } of sessions) {
    projects[`/tmp/project-${sessionId}`] = {
      lastSessionId: sessionId,
      lastSessionModified: modified,
    };
  }
  writeFileSync(
    join(profilePath, '.claude.json'),
    JSON.stringify({ projects }),
  );
}

function writeTranscript(cwdHash: string, sessionId: string, lines: unknown[]) {
  const dir = join(TEST_DIR, 'shared', 'projects', cwdHash);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

function assistantLine(
  sessionId: string,
  requestId: string,
  usage: Record<string, unknown>,
  timestamp = NOW_TS,
) {
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

function queueOperationLine() {
  return {
    type: 'queue-operation',
    operation: 'task',
    timestamp: NOW_TS,
  };
}

beforeEach(() => {
  originalAimuxDir = getAimuxDir();
  mkdirSync(TEST_DIR, { recursive: true });
  setAimuxDir(join(TEST_DIR, '.aimux'));
});

afterEach(() => {
  setAimuxDir(originalAimuxDir);
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('summarizeUsage', () => {
  it('attributes transcript usage to profiles via .claude.json session ownership', () => {
    writeProfileSession('work', 'session-a', 1000);
    writeTranscript('-tmp-project', 'session-a', [
      assistantLine('session-a', 'req-1', {
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
    const repeated = assistantLine('session-a', 'req-1', {
      input_tokens: 10,
      output_tokens: 5,
    });
    writeTranscript('-tmp-project', 'session-a', [repeated, repeated]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.requests).toBe(1);
    expect(work.inputTokens).toBe(10);
    expect(work.outputTokens).toBe(5);
  });

  it('deduplicates forked sessions that share a requestId', () => {
    writeProfileSessions('work', [
      { sessionId: 'session-original', modified: 1000 },
      { sessionId: 'session-fork', modified: 2000 },
    ]);
    writeTranscript('-tmp-project', 'session-original', [
      assistantLine('session-original', 'req-shared', {
        input_tokens: 10,
        output_tokens: 5,
      }),
    ]);
    writeTranscript('-tmp-project', 'session-fork', [
      assistantLine('session-fork', 'req-shared', {
        input_tokens: 10,
        output_tokens: 5,
      }, LATER_TS),
    ]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.requests).toBe(1);
    expect(work.inputTokens).toBe(10);
    expect(work.outputTokens).toBe(5);
  });

  it('skips subagent transcripts', () => {
    writeProfileSession('work', 'session-subagent', 1000);
    writeTranscript('-tmp-project', 'session-subagent', [
      queueOperationLine(),
      assistantLine('session-subagent', 'req-subagent', {
        input_tokens: 1000,
        output_tokens: 500,
      }),
    ]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.requests).toBe(0);
    expect(totalTokens(work)).toBe(0);
  });

  it('counts stable line fallback keys when request identifiers are missing', () => {
    writeProfileSession('work', 'session-a', 1000);
    const line = assistantLine('session-a', '', {
      input_tokens: 10,
      estimated_cost_usd: 0.01,
    });
    delete line.requestId;
    delete line.message.id;
    writeTranscript('-tmp-project', 'session-a', [line, line]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.requests).toBe(2);
    expect(work.inputTokens).toBe(20);
    expect(work.estimatedCostUsd).toBe(0.02);
  });

  it('ignores malformed non-numeric usage values', () => {
    writeProfileSession('work', 'session-a', 1000);
    writeTranscript('-tmp-project', 'session-a', [
      assistantLine('session-a', 'req-bad', {
        input_tokens: '10',
        output_tokens: Number.NaN,
      }),
    ]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.requests).toBe(1);
    expect(totalTokens(work)).toBe(0);
  });

  it('derives estimated cost from the price table when transcripts lack cost', () => {
    writeProfileSession('work', 'session-a', 1000);
    writeTranscript('-tmp-project', 'session-a', [
      assistantLine('session-a', 'req-1', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    // assistantLine() uses model claude-opus-4-7 = $15 in + $75 out per 1M.
    expect(work.estimatedCostUsd).toBeCloseTo(90, 6);
  });

  it('prefers transcript cost over the price-table estimate when present', () => {
    writeProfileSession('work', 'session-a', 1000);
    writeTranscript('-tmp-project', 'session-a', [
      assistantLine('session-a', 'req-1', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        estimated_cost_usd: 0.5,
      }),
    ]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.estimatedCostUsd).toBe(0.5);
  });

  it('leaves cost at 0 when the model has no price entry', () => {
    writeProfileSession('work', 'session-a', 1000);
    const line = assistantLine('session-a', 'req-x', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });
    line.message.model = 'mystery-model-x';
    writeTranscript('-tmp-project', 'session-a', [line]);

    const work = summarizeUsage(makeConfig()).find((s) => s.profile === 'work')!;
    expect(work.estimatedCostUsd).toBe(0);
  });

  it('filters by profile and since timestamp', () => {
    writeProfileSession('main', 'session-main', 1000);
    writeProfileSession('work', 'session-work', 1000);
    writeTranscript('-tmp-project', 'session-main', [
      assistantLine('session-main', 'req-main', { input_tokens: 100 }, OLD_TS),
    ]);
    writeTranscript('-tmp-project', 'session-work', [
      assistantLine('session-work', 'req-old', { input_tokens: 100 }, OLD_TS),
      assistantLine('session-work', 'req-new', { input_tokens: 200 }),
    ]);

    const summaries = summarizeUsage(makeConfig(), {
      profile: 'work',
      sinceMs: Date.parse(CUTOFF_TS),
    });
    expect(summaries.map((s) => s.profile)).toEqual(['work']);
    expect(summaries[0].requests).toBe(1);
    expect(summaries[0].inputTokens).toBe(200);
  });
});

describe('parseSinceDuration', () => {
  it('parses hours, days, and weeks', () => {
    const now = Date.parse(NOW_TS);
    expect(parseSinceDuration('24h', now)).toBe(now - 24 * 60 * 60 * 1000);
    expect(parseSinceDuration('7d', now)).toBe(now - 7 * 24 * 60 * 60 * 1000);
    expect(parseSinceDuration('2w', now)).toBe(now - 14 * 24 * 60 * 60 * 1000);
  });

  it('rejects invalid durations', () => {
    expect(() => parseSinceDuration('yesterday')).toThrow('Invalid duration');
  });
});
